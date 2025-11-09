import cv2
import mediapipe as mp
import numpy as np
import math
from typing import List, Tuple, Optional
import time
import os
import requests
import threading
import socketio
from renderer_3d import Renderer3D
from virtual_object_3d import VirtualObject3D

class VirtualObject:
    """Represents a virtual object that can be manipulated in AR space"""
    
    def __init__(self, x: float, y: float, size: float = 50, color: Tuple[int, int, int] = (0, 255, 255), shape: str = "circle"):
        self.x = x
        self.y = y
        self.size = size
        self.original_size = size
        self.color = color
        self.shape = shape
        self.is_grabbed = 0  # 0 = not grabbed, 1 = grabbed with 1 hand, 2 = grabbed with 2 hands
        self.grabbed_by_hand = []  # List of hand indices that are grabbing this object
        self.z_depth = 0.0 
        
    def draw(self, frame: np.ndarray) -> np.ndarray:
        """Draw the virtual object on the frame"""
        center = (int(self.x), int(self.y))
        radius = int(self.size)
        
        if self.shape == "circle":
            for i in range(radius, 0, -2):
                alpha = 0.8 * (i / radius)
                color = tuple(int(c * alpha) for c in self.color)
                cv2.circle(frame, center, i, color, -1)
                
            # Draw grab indicator based on grab state
            if self.is_grabbed == 1:
                cv2.circle(frame, center, radius + 5, (255, 255, 255), 3)  # White ring for 1 hand
            elif self.is_grabbed == 2:
                cv2.circle(frame, center, radius + 5, (255, 255, 0), 5)  # Yellow ring for 2 hands
                
        return frame
    
    def is_point_inside(self, x: float, y: float) -> bool:
        """Check if a point is inside the object"""
        distance = math.sqrt((x - self.x) ** 2 + (y - self.y) ** 2)
        return distance <= self.size
    
    def move_to(self, x: float, y: float):
        self.x = x
        self.y = y
    
    def scale(self, scale_factor: float):
        self.size = max(10, min(200, self.original_size * scale_factor))


class HandGestureDetector:
    
    def __init__(self):
        # Config to use remote landmarks (from Flask) instead of local MediaPipe
        self.use_remote = os.environ.get("USE_REMOTE_HANDS", "1") not in ("0", "false", "False")
        # Optional: use Socket.IO direct stream from signaling server
        self.use_socketio = os.environ.get("USE_SOCKETIO_HANDS", "1") in ("1", "true", "True")
        self.signaling_base = os.environ.get("SIGNALING_BASE_URL", "http://localhost:3001")
        self.flask_base = os.environ.get("FLASK_BASE_URL", "http://127.0.0.1:5001")
        self.room_id = os.environ.get("ROOM_ID", "demo")
        self.session = requests.Session()
        self.latest_skeleton = None
        self.latest_skeleton_ms = 0
        self._skel_lock = threading.Lock()
        self._sio = None
        self._sio_thread = None
        if self.use_socketio:
            self._start_socketio_client()
        if not self.use_remote:
            self.mp_hands = mp.solutions.hands
            self.hands = self.mp_hands.Hands(
                static_image_mode=False,
                max_num_hands=2,
                min_detection_confidence=0.7,
                min_tracking_confidence=0.5
            )
            self.mp_drawing = mp.solutions.drawing_utils
    
    def _start_socketio_client(self):
        self._sio = socketio.Client(reconnection=True, logger=False, engineio_logger=False)
        @self._sio.event
        def connect():
            try:
                print(f"[AR] Socket.IO connected to {self.signaling_base}")
                self._sio.emit('join-room', {'roomId': self.room_id, 'role': 'observer', 'userName': 'AR Python'})
                print(f"[AR] Emitted join-room roomId={self.room_id}")
            except Exception:
                print("[AR] Error emitting join-room")
        @self._sio.on('hand-skeleton')
        def on_hand_skeleton(msg):
            try:
                with self._skel_lock:
                    # msg: { skeleton: {...}, senderId, timestamp }
                    self.latest_skeleton = msg.get('skeleton')
                    self.latest_skeleton_ms = int(time.time() * 1000)
                # Print only occasionally to avoid spam
                if self.latest_skeleton and self.latest_skeleton.get('landmarks'):
                    lm_count = len(self.latest_skeleton['landmarks'])
                    print(f"[AR] Received hand-skeleton ({lm_count} pts)")
            except Exception:
                print("[AR] Error handling hand-skeleton message")
        @self._sio.event
        def disconnect():
            print("[AR] Socket.IO disconnected")
        @self._sio.event
        def connect_error(data):
            print(f"[AR] Socket.IO connect_error: {data}")
        @self._sio.event
        def reconnect_attempt(number):
            print(f"[AR] Socket.IO reconnect attempt {number}")
        def run():
            try:
                self._sio.connect(self.signaling_base, transports=['websocket', 'polling'])
                self._sio.wait()
            except Exception:
                print("[AR] Socket.IO thread terminated unexpectedly")
        self._sio_thread = threading.Thread(target=run, daemon=True)
        self._sio_thread.start()
        
    def detect_hands(self, frame: np.ndarray) -> List[dict]:
        if self.use_socketio:
            try:
                with self._skel_lock:
                    skel = self.latest_skeleton
                    last_ms = self.latest_skeleton_ms
                if not skel:
                    # Timed fallback to Flask if configured and stale
                    if self.use_remote:
                        now_ms = int(time.time() * 1000)
                        # If no socket events for > 800ms, try one-off Flask fetch
                        if now_ms - last_ms > 800:
                            try:
                                url = f"{self.flask_base.rstrip('/')}/landmarks/latest"
                                resp = self.session.get(url, params={"room_id": self.room_id}, timeout=0.5)
                                if resp.ok:
                                    payload = resp.json() or {}
                                    data = payload.get("data") or {}
                                    skel = data.get("skeleton") or {}
                            except Exception:
                                pass
                if not skel:
                    return []
                landmarks = skel.get("landmarks") or []
                if not landmarks:
                    return []
                hand_info = self._extract_hand_info_from_normalized(landmarks, frame.shape, skel.get("handedness"))
                hand_info['hand_idx'] = 0
                return [hand_info]
            except Exception:
                return []
        elif self.use_remote:
            # Fetch latest skeleton from Flask and adapt to hands_info
            try:
                url = f"{self.flask_base.rstrip('/')}/landmarks/latest"
                resp = self.session.get(url, params={"room_id": self.room_id}, timeout=2.5)
                resp.raise_for_status()
                payload = resp.json() or {}
                data = payload.get("data") or {}
                skel = data.get("skeleton") or {}
                landmarks = skel.get("landmarks") or []
                if not landmarks:
                    return []
                hand_info = self._extract_hand_info_from_normalized(landmarks, frame.shape, skel.get("handedness"))
                hand_info['hand_idx'] = 0
                return [hand_info]
            except Exception:
                return []
        else:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.hands.process(rgb_frame)
            
            hands_info = []
            if results.multi_hand_landmarks:
                handedness_list = results.multi_handedness or []
                for hand_idx, hand_landmarks in enumerate(results.multi_hand_landmarks):
                    hand_info = self._extract_hand_info(hand_landmarks, frame.shape)
                    hand_info['landmarks'] = hand_landmarks
                    hand_info['hand_idx'] = hand_idx

                    if hand_idx < len(handedness_list) and handedness_list[hand_idx].classification:
                        classification = handedness_list[hand_idx].classification[0]
                        label = classification.label.lower()
                        hand_info['hand_label'] = label
                        hand_info['hand_confidence'] = classification.score
                        hand_info['hand_is_left'] = label == "left"
                        hand_info['hand_is_right'] = label == "right"
                    else:
                        hand_info['hand_label'] = "unknown"
                        hand_info['hand_confidence'] = 0.0
                        hand_info['hand_is_left'] = False
                        hand_info['hand_is_right'] = False

                    hands_info.append(hand_info)
                    
            return hands_info
    
    def _extract_hand_info(self, landmarks, frame_shape) -> dict:
        h, w = frame_shape[:2]
        
        thumb_tip = landmarks.landmark[4]
        index_tip = landmarks.landmark[8]
        middle_tip = landmarks.landmark[12]
        ring_tip = landmarks.landmark[16]
        pinky_tip = landmarks.landmark[20]
        
        wrist = landmarks.landmark[0]
        index_mcp = landmarks.landmark[5]
        
        # Convert to pixel coordinates
        thumb_pos = (int(thumb_tip.x * w), int(thumb_tip.y * h))
        index_pos = (int(index_tip.x * w), int(index_tip.y * h))
        middle_pos = (int(middle_tip.x * w), int(middle_tip.y * h))
        wrist_pos = (int(wrist.x * w), int(wrist.y * h))
        
        # Calculate palm center
        palm_x = int((wrist.x + index_mcp.x) * w / 2)
        palm_y = int((wrist.y + index_mcp.y) * h / 2)
        palm_center = (palm_x, palm_y)
        
        # Detect gestures
        gestures = self._detect_gestures(landmarks)
        
        pinch_distance = math.sqrt((thumb_pos[0] - index_pos[0]) ** 2 + (thumb_pos[1] - index_pos[1]) ** 2)
        
        # Calculate pinch center for better tracking
        pinch_center = ((thumb_pos[0] + index_pos[0]) // 2, (thumb_pos[1] + index_pos[1]) // 2)
        
        # More reliable pinch detection with multiple criteria
        # Check if fingers are actually bent (not just close together)
        thumb_bent = thumb_tip.x < landmarks.landmark[3].x  # Thumb is bent inward
        index_bent = index_tip.y > landmarks.landmark[6].y  # Index finger is bent down
        
        # Much more lenient pinch detection - prioritize distance over finger position
        # Primary method: distance-based
        is_pinching = (pinch_distance < 60 and  # Increased distance threshold
                      pinch_distance > 10 and  # Not too close (avoid noise)
                      (thumb_bent or index_bent or pinch_distance < 35))  # Either finger bent OR very close
        
        # Fallback method: if distance is very close, always consider it pinching
        if pinch_distance < 25:
            is_pinching = True
        
        return {
            'thumb_pos': thumb_pos,
            'index_pos': index_pos,
            'middle_pos': middle_pos,
            'palm_center': palm_center,
            'pinch_center': pinch_center,
            'wrist_pos': wrist_pos,
            'gestures': gestures,
            'pinch_distance': pinch_distance,
            'is_pinching': is_pinching,
            'thumb_bent': thumb_bent,
            'index_bent': index_bent
        }
    
    def _extract_hand_info_from_normalized(self, lm_list: List[dict], frame_shape, handedness: Optional[str]) -> dict:
        """Build the same structure as _extract_hand_info using normalized landmark dicts ({x,y,z})."""
        h, w = frame_shape[:2]
        def get(i):
            if i < 0 or i >= len(lm_list): 
                return {'x': 0.0, 'y': 0.0, 'z': 0.0}
            return lm_list[i]
        thumb_tip = get(4)
        index_tip = get(8)
        middle_tip = get(12)
        ring_tip = get(16)
        pinky_tip = get(20)
        wrist = get(0)
        index_mcp = get(5)
        # Pixel coords
        thumb_pos = (int(thumb_tip['x'] * w), int(thumb_tip['y'] * h))
        index_pos = (int(index_tip['x'] * w), int(index_tip['y'] * h))
        middle_pos = (int(middle_tip['x'] * w), int(middle_tip['y'] * h))
        wrist_pos = (int(wrist['x'] * w), int(wrist['y'] * h))
        palm_x = int((wrist['x'] + index_mcp['x']) * w / 2)
        palm_y = int((wrist['y'] + index_mcp['y']) * h / 2)
        palm_center = (palm_x, palm_y)
        pinch_distance = math.sqrt((thumb_pos[0] - index_pos[0]) ** 2 + (thumb_pos[1] - index_pos[1]) ** 2)
        pinch_center = ((thumb_pos[0] + index_pos[0]) // 2, (thumb_pos[1] + index_pos[1]) // 2)
        # Bent heuristics
        thumb_bent = thumb_tip['x'] < get(3)['x']
        index_bent = index_tip['y'] > get(6)['y']
        # Pinch heuristic
        is_pinching = (pinch_distance < 60 and pinch_distance > 10 and (thumb_bent or index_bent or pinch_distance < 35))
        if pinch_distance < 25:
            is_pinching = True
        gestures = self._detect_gestures_from_list(lm_list)
        info = {
            'thumb_pos': thumb_pos,
            'index_pos': index_pos,
            'middle_pos': middle_pos,
            'palm_center': palm_center,
            'pinch_center': pinch_center,
            'wrist_pos': wrist_pos,
            'gestures': gestures,
            'pinch_distance': pinch_distance,
            'is_pinching': is_pinching,
            'thumb_bent': thumb_bent,
            'index_bent': index_bent
        }
        # Handedness mapping
        if handedness:
            label = handedness.lower()
            info['hand_label'] = label
            info['hand_confidence'] = 1.0
            info['hand_is_left'] = label == 'left'
            info['hand_is_right'] = label == 'right'
        else:
            info['hand_label'] = 'unknown'
            info['hand_confidence'] = 0.0
            info['hand_is_left'] = False
            info['hand_is_right'] = False
        return info
    
    def _detect_gestures(self, landmarks) -> List[str]:
        """Detect specific hand gestures"""
        gestures = []
        
        # Get finger tip and pip positions
        fingertips = [4, 8, 12, 16, 20]  # thumb, index, middle, ring, pinky
        pip_joints = [3, 6, 10, 14, 18]
        
        # Count extended fingers
        extended_fingers = []
        
        # Thumb (special case - check x coordinate)
        if landmarks.landmark[4].x > landmarks.landmark[3].x:
            extended_fingers.append(True)
        else:
            extended_fingers.append(False)
            
        # Other fingers
        for i in range(1, 5):
            if landmarks.landmark[fingertips[i]].y < landmarks.landmark[pip_joints[i]].y:
                extended_fingers.append(True)
            else:
                extended_fingers.append(False)
        
        extended_count = sum(extended_fingers)
        
        # Classify gestures
        if extended_count == 0:
            gestures.append("fist")
        elif extended_count == 1 and extended_fingers[1]:  # Only index finger
            gestures.append("pointing")
        elif extended_count == 2 and extended_fingers[0] and extended_fingers[1]:  # Thumb + index
            gestures.append("pinch")
        elif extended_count == 5:
            gestures.append("open_hand")
        elif extended_count == 2 and extended_fingers[1] and extended_fingers[2]:  # Index + middle
            gestures.append("peace")
            
        return gestures
    
    def _detect_gestures_from_list(self, lm_list: List[dict]) -> List[str]:
        """Detect gestures given a list of normalized dicts."""
        gestures = []
        def y(i): 
            return lm_list[i]['y'] if 0 <= i < len(lm_list) else 0.0
        def x(i): 
            return lm_list[i]['x'] if 0 <= i < len(lm_list) else 0.0
        fingertips = [4, 8, 12, 16, 20]
        pip_joints = [3, 6, 10, 14, 18]
        extended_fingers = []
        extended_fingers.append(x(4) > x(3))  # thumb
        for i in range(1, 5):
            extended_fingers.append(y(fingertips[i]) < y(pip_joints[i]))
        extended_count = sum(1 for f in extended_fingers if f)
        if extended_count == 0:
            gestures.append("fist")
        elif extended_count == 1 and extended_fingers[1]:
            gestures.append("pointing")
        elif extended_count == 2 and extended_fingers[0] and extended_fingers[1]:
            gestures.append("pinch")
        elif extended_count == 5:
            gestures.append("open_hand")
        elif extended_count == 2 and extended_fingers[1] and extended_fingers[2]:
            gestures.append("peace")
        return gestures
    
    def draw_landmarks(self, frame: np.ndarray, hands_info: List[dict]) -> np.ndarray:
        """Draw hand landmarks on frame"""
        for hand_info in hands_info:
            if 'landmarks' in hand_info:
                self.mp_drawing.draw_landmarks(
                    frame, hand_info['landmarks'], self.mp_hands.HAND_CONNECTIONS)
        return frame


class ARHandController:
    """Main AR application for hand-controlled object manipulation"""
    
    def __init__(self):
        # Hand detector
        self.detector = HandGestureDetector()
        
        # Virtual objects
        self.objects: List[VirtualObject] = []
        
        # Test mode for JARVIS without camera
        self.test_mode = False
        self.jarvis_activated = False
        
        # Interaction state
        self.grab_states = {}  # hand_idx -> {object, initial_pinch_distance, initial_size}
        self.grab_states_3d = {}  # hand_idx -> {object, initial_pinch_distance, initial_size, last_hand_pos}
        self.last_frame_time = time.time()
        
        # Pinch state tracking for hysteresis
        self.pinch_states = {}  # hand_idx -> {'was_pinching': bool, 'pinch_frames': int}
        
        # Selection system tracking (two-hand selection)
        self.selection_mode_objects = set()  # Set of objects currently in selection mode (grabbed by 2 hands)
        
        # Explicit rotation mode tracking (simplified)
        # No longer needed - using explicit rotation state in VirtualObject3D
        
        # Display mode
        self.show_3d_objects = True
        self.show_2d_objects = True
        
        # Create some initial objects
        self._create_initial_objects()
        
    def _create_initial_objects(self):
        """Create initial virtual objects"""
        # 2D objects
        self.objects = [
            VirtualObject(200, 200, 60, (0, 255, 255), "circle"),  # Yellow ball
            VirtualObject(400, 300, 80, (255, 100, 100), "cube"),   # Blue cube
            VirtualObject(600, 250, 50, (100, 255, 100), "circle"), # Green ball
        ]
        
        # 3D objects
        self.objects_3d = []
        
        # Load multiple CAD components for testing
        cad_models = [
            {
                "path": "online/Wooden Crate.obj",
                "name": "Wood Crate",
                "position": (0.0, 0.0, -4.0),
                "scale": 0.7,
                "color": (100, 150, 255)
            },
            {
                "path": "online/Needle.obj",
                "name": "Needle",
                "position": (-2.5, 1.0, -3.0),
                "scale": 1.2,
                "color": (255, 80, 120)
            },
            {
                "path": "ironman_simple.obj",
                "name": "Iron Man",
                "position": (3.0, 0.0, -2.0),
                "scale": 0.7,
                "color": (100, 150, 255)
            },
        ]
        
        for model_info in cad_models:
            model_path = os.path.join(os.path.dirname(__file__), model_info["path"])
            if os.path.exists(model_path):
                obj_3d = VirtualObject3D(
                    model_path, 
                    x=model_info["position"][0], 
                    y=model_info["position"][1], 
                    z=model_info["position"][2],
                    scale=model_info["scale"], 
                    color=model_info["color"]
                )
                obj_3d.set_render_mode("solid")
                # Set different auto-rotation speeds for variety
                obj_3d.auto_rotation_speed = 0.01 + len(self.objects_3d) * 0.005
                self.objects_3d.append(obj_3d)
                print(f"✅ Loaded {model_info['name']} from {model_info['path']}")
            else:
                print(f"⚠️  {model_info['name']} not found at {model_path}")
    
    def start(self):
        """Start the AR application"""
        # Try different camera indices with better error handling
        camera_indices = [0, 1, 2]  # Try multiple camera indices
        
        for index in camera_indices:
            print(f"Trying camera index {index}...")
            self.cap = cv2.VideoCapture(index)
            
            # Set camera properties for better compatibility
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)
            
            if self.cap.isOpened():
                # Test if we can actually read from the camera
                ret, test_frame = self.cap.read()
                if ret and test_frame is not None:
                    print(f"✅ Successfully opened camera {index}")
                    print(f"   Resolution: {int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
                    print(f"   FPS: {int(self.cap.get(cv2.CAP_PROP_FPS))}")
                    break
                else:
                    print(f"❌ Camera {index} opened but cannot read frames")
                    self.cap.release()
            else:
                print(f"❌ Could not open camera {index}")
        else:
            print("❌ Error: Could not open any camera")
            print("\n🔧 Troubleshooting tips:")
            print("1. Check System Preferences → Privacy & Security → Camera")
            print("2. Allow Terminal (or your Python IDE) to access the camera")
            print("3. Make sure no other applications are using the camera")
            print("4. Try running with different backend: 'export OPENCV_VIDEOIO_PRIORITY_LIST=AVFOUNDATION'")
            print("5. Try running: 'python3.11 launch_app.py' for GUI launcher")
            
            # Continue without camera for JARVIS testing
            print("\n🤖 JARVIS Integration Test Mode:")
            print("- Camera disabled, but JARVIS voice assistant still works")
            print("- Press 'J' to test JARVIS activation")
            print("- Use synthetic 3D objects for JARVIS visual analysis")
            
            self.test_mode = True
            self.cap = None
            
        # Set camera resolution if camera is available
        if self.cap is not None:
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        
        # Initialize 3D renderer
        self.renderer_3d = Renderer3D(1280, 720)
        
        self.is_running = True
        print("AR Hand Control started!")
        print("Gestures:")
        print("- Pinch (thumb + index) near object: Grab object")
        print("- Move hand while pinching: Move object (improved 3D tracking!)")
        print("- Grab object with TWO hands and move apart/closer: Scale object")
        print("- Two hands: Rotate 3D objects (open left = X-axis tilt, open right = Y-axis spin)")
        print("- 3D objects now follow pinch point more accurately")
        print("Controls:")
        print("- Press 'q' to quit")
        print("- Press 'r' to reset objects")
        print("- Press 'c' to add new 2D object")
        print("- Press '1' to toggle 2D objects")
        print("- Press '2' to toggle 3D objects")
        print("- Press 'w' to toggle wireframe/solid rendering")
        print("- Press 't' to toggle auto-rotation")
        print("- Press 'x/y/z' to reset rotation on specific axis")
        print("- Press 'space' to cycle through 3D objects")
        print("- Press 'j' to activate JARVIS voice assistant")
        
        while self.is_running:
            self._process_frame()
            
        self._cleanup()
    
    def _create_test_frame(self):
        """Create a synthetic frame for testing JARVIS without camera"""
        # Create a black frame with 3D objects rendered
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        
        # Add some visual elements to make it interesting for JARVIS
        cv2.putText(frame, "AR Hand Control - JARVIS Test Mode", 
                   (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
        
        if self.jarvis_activated:
            cv2.putText(frame, "JARVIS ACTIVE - Voice Assistant Ready", 
                       (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
            cv2.putText(frame, "Say 'What is this?' to analyze 3D objects", 
                       (50, 130), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        
        # Add instructions
        cv2.putText(frame, "Press 'J' to toggle JARVIS", 
                   (50, 680), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 2)
        cv2.putText(frame, "Press '2' to show 3D objects", 
                   (50, 700), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 2)
        
        return frame
    
    def save_screenshot_for_jarvis(self, frame):
        """Save current frame as screenshot for JARVIS analysis"""
        try:
            screenshot_path = "jarvis_screenshot.png"
            cv2.imwrite(screenshot_path, frame)
            print(f"📸 Screenshot saved for JARVIS analysis: {screenshot_path}")
            return screenshot_path
        except Exception as e:
            print(f"❌ Failed to save screenshot: {e}")
            return None
    
    def _process_frame(self):
        """Process a single frame"""
        if self.test_mode or self.cap is None:
            # Create synthetic frame for JARVIS testing
            frame = self._create_test_frame()
        else:
            ret, frame = self.cap.read()
            if not ret:
                print("Failed to capture frame")
                self.is_running = False
                return
        
        # Flip frame horizontally for mirror effect
        frame = cv2.flip(frame, 1)
        
        # Detect hands
        hands_info = self.detector.detect_hands(frame)
        
        # Process interactions
        self._process_interactions(hands_info)
        
        # Store hands_info for scaling calculations
        self.current_hands_info = hands_info
        
        # Draw 2D objects
        if self.show_2d_objects:
            for obj in self.objects:
                frame = obj.draw(frame)
        
        # Draw 3D objects
        if self.show_3d_objects and self.renderer_3d:
            for i, obj_3d in enumerate(self.objects_3d):
                # Only show pinchable radius for the first two 3D objects
                if i < 2:
                    obj_3d.selected = (i == 0)  # First object is selected (yellow), second is not (blue)
                else:
                    obj_3d.selected = None  # Hide radius for objects beyond the first two
                frame = obj_3d.draw(frame, self.renderer_3d)
                
                # Draw targeting indicator for 3D objects when pinching near them
                for hand_info in hands_info:
                    if (hand_info['is_pinching'] and 
                        not obj_3d.is_grabbed and 
                        obj_3d.is_point_inside(hand_info['pinch_center'][0], hand_info['pinch_center'][1], self.renderer_3d)):
                        
                        screen_pos = obj_3d.get_screen_position(self.renderer_3d)
                        if screen_pos:
                            # Draw targeting circle
                            cv2.circle(frame, (int(screen_pos[0]), int(screen_pos[1])), 60, (255, 255, 0), 3)
                            cv2.circle(frame, (int(screen_pos[0]), int(screen_pos[1])), 40, (255, 255, 0), 2)
                            
                            # Draw line from pinch center to object center
                            cv2.line(frame, hand_info['pinch_center'], (int(screen_pos[0]), int(screen_pos[1])), (255, 255, 0), 2)
            
        # Draw hand landmarks
        frame = self.detector.draw_landmarks(frame, hands_info)
        
        # Draw UI
        frame = self._draw_ui(frame, hands_info)
        
        # Draw rotation hand indicators
        frame = self._draw_rotation_hand_indicators(frame, hands_info)
        
        # Show frame
        cv2.imshow('AR Hand Control', frame)
        
        # Handle keyboard input
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            self.is_running = False
        elif key == ord('r'):
            self._create_initial_objects()
            self.grab_states.clear()
            self.grab_states_3d.clear()
        elif key == ord('c'):
            self._add_random_object()
        elif key == ord('1'):
            self.show_2d_objects = not self.show_2d_objects
            print(f"2D objects: {'ON' if self.show_2d_objects else 'OFF'}")
        elif key == ord('2'):
            self.show_3d_objects = not self.show_3d_objects
            print(f"3D objects: {'ON' if self.show_3d_objects else 'OFF'}")
        elif key == ord('w'):
            # Toggle wireframe/solid for 3D objects
            for obj_3d in self.objects_3d:
                if obj_3d.render_mode == "solid":
                    obj_3d.set_render_mode("wireframe")
                else:
                    obj_3d.set_render_mode("solid")
            print(f"3D render mode: {self.objects_3d[0].render_mode if self.objects_3d else 'N/A'}")
        elif key == ord('t'):
            # Toggle auto-rotation for 3D objects
            for obj_3d in self.objects_3d:
                obj_3d.toggle_auto_rotation()
            auto_rotate_status = self.objects_3d[0].auto_rotate if self.objects_3d else False
            print(f"Auto-rotation: {'ON' if auto_rotate_status else 'OFF'}")
        elif key == ord('x'):
            # Reset X-axis rotation for all 3D objects
            for obj_3d in self.objects_3d:
                obj_3d.rotation_x = 0.0
            print("Reset X-axis rotation")
        elif key == ord('y'):
            # Reset Y-axis rotation for all 3D objects
            for obj_3d in self.objects_3d:
                obj_3d.rotation_y = 0.0
            print("Reset Y-axis rotation")
        elif key == ord('z'):
            # Reset Z-axis rotation for all 3D objects
            for obj_3d in self.objects_3d:
                obj_3d.rotation_z = 0.0
            print("Reset Z-axis rotation")
        elif key == ord('j'):
            # Activate JARVIS voice assistant
            print("🤖 Activating JARVIS voice assistant...")
            self.jarvis_activated = not self.jarvis_activated
            if self.jarvis_activated:
                print("✅ JARVIS activated - Voice assistant ready")
                print("🗣️  Say 'What is this?' to analyze the 3D objects")
                print("📸 JARVIS will take a screenshot and analyze what you're looking at")
                
                # Save screenshot for JARVIS analysis
                screenshot_path = self.save_screenshot_for_jarvis(frame)
                if screenshot_path:
                    print("🧠 Screenshot ready for JARVIS vision analysis")
                    print("💡 Open the web interface and activate JARVIS to analyze this image")
                
                cv2.putText(frame, "JARVIS ACTIVATED - Voice Assistant Ready", 
                           (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                cv2.putText(frame, "Screenshot saved for analysis", 
                           (50, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
            else:
                print("🤖 JARVIS deactivated")
                cv2.putText(frame, "JARVIS DEACTIVATED", 
                           (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        elif key == ord(' '):  # Spacebar
            # Cycle through 3D objects (select next one)
            if self.objects_3d:
                # Find currently selected object or start with first
                current_selected = -1
                for i, obj_3d in enumerate(self.objects_3d):
                    if obj_3d.selected and not obj_3d.is_grabbed:  # Don't cycle away from grabbed objects
                        current_selected = i
                        obj_3d.selected = False
                        break
                
                # Select next object (skip grabbed objects)
                next_index = (current_selected + 1) % len(self.objects_3d)
                attempts = 0
                while self.objects_3d[next_index].is_grabbed and attempts < len(self.objects_3d):
                    next_index = (next_index + 1) % len(self.objects_3d)
                    attempts += 1
                
                self.objects_3d[next_index].selected = True
                print(f"Selected 3D object {next_index + 1}/{len(self.objects_3d)}")
        elif key == ord('s'):  # 'S' key for cycling 2D objects
            # Cycle through 2D objects (select next one)
            if self.objects:
                # Find currently selected object or start with first
                current_selected = -1
                for i, obj in enumerate(self.objects):
                    if obj.selected and not obj.is_grabbed:  # Don't cycle away from grabbed objects
                        current_selected = i
                        obj.selected = False
                        break
                
                # Select next object (skip grabbed objects)
                next_index = (current_selected + 1) % len(self.objects)
                attempts = 0
                while self.objects[next_index].is_grabbed and attempts < len(self.objects):
                    next_index = (next_index + 1) % len(self.objects)
                    attempts += 1
                
                self.objects[next_index].selected = True
                print(f"Selected 2D object {next_index + 1}/{len(self.objects)}")
    
    def _process_interactions(self, hands_info: List[dict]):
        """Process hand interactions with objects"""
        current_grabs = set()
        current_grabs_3d = set()
        
        for hand_info in hands_info:
            hand_idx = hand_info['hand_idx']
            is_pinching = hand_info['is_pinching']
            
            # Initialize pinch state if not exists
            if hand_idx not in self.pinch_states:
                self.pinch_states[hand_idx] = {'was_pinching': False, 'pinch_frames': 0}
            
            pinch_state = self.pinch_states[hand_idx]
            
            # Minimal hysteresis: require 1 frame to start, 1 frame to stop
            if is_pinching:
                pinch_state['pinch_frames'] += 1
                if pinch_state['pinch_frames'] >= 1:  # Start pinching after 1 frame
                    pinch_state['was_pinching'] = True
            else:
                pinch_state['pinch_frames'] = 0  # Immediately reset when not pinching
                pinch_state['was_pinching'] = False  # Immediately stop pinching
            
            # Use the stabilized pinch state
            stabilized_pinching = pinch_state['was_pinching']
            
            if stabilized_pinching:
                # Try 3D objects first
                if self.show_3d_objects and self._handle_pinch_interaction_3d(hand_info, hand_idx):
                    current_grabs_3d.add(hand_idx)
                # Then try 2D objects
                elif self.show_2d_objects:
                    self._handle_pinch_interaction(hand_info, hand_idx)
                    current_grabs.add(hand_idx)
            
            else:
                # Release any grabbed 2D object
                if hand_idx in self.grab_states:
                    obj = self.grab_states[hand_idx]['object']
                    # Remove this hand from the grabbed_by_hand list
                    if hand_idx in obj.grabbed_by_hand:
                        obj.grabbed_by_hand.remove(hand_idx)
                    # Update grab state based on remaining hands
                    obj.is_grabbed = len(obj.grabbed_by_hand)
                    # Deselect object when completely released
                    if obj.is_grabbed == 0:
                        obj.selected = False
                    
                    # Reset scaling state if transitioning from two-hand to one-hand or no hands
                    if obj.is_grabbed < 2:
                        # Clear two-hand scaling state from all hands grabbing this object
                        for other_hand_idx in obj.grabbed_by_hand:
                            if other_hand_idx in self.grab_states:
                                other_hand_state = self.grab_states[other_hand_idx]
                                if 'initial_two_hand_distance' in other_hand_state:
                                    del other_hand_state['initial_two_hand_distance']
                                if 'initial_size' in other_hand_state:
                                    del other_hand_state['initial_size']
                    
                    del self.grab_states[hand_idx]
                
                # Release any grabbed 3D object
                if hand_idx in self.grab_states_3d:
                    obj_3d = self.grab_states_3d[hand_idx]['object']
                    grab_state = self.grab_states_3d[hand_idx]
                    
                    # Check if this release would create a rotation mode opportunity
                    # (transitioning from 2-hand to 1-hand grab)
                    if obj_3d.is_grabbed == 2 and len(obj_3d.grabbed_by_hand) == 2:
                        # This is a 2-hand grab, check if we should enter rotation mode
                        other_hand_idx = None
                        for other_hand in obj_3d.grabbed_by_hand:
                            if other_hand != hand_idx:
                                other_hand_idx = other_hand
                                break
                        
                        if other_hand_idx is not None:
                            # Check if the other hand is still pinching
                            other_hand_pinching = any(hand['hand_idx'] == other_hand_idx and hand['is_pinching'] for hand in hands_info)
                            
                            if other_hand_pinching:
                                # Other hand is still pinching - enter rotation mode with released hand
                                obj_3d.is_in_rotation_mode = True
                                obj_3d.rotation_hand_idx = hand_idx
                                
                                # Get initial position of rotation hand
                                rotation_hand_info = next((hand for hand in hands_info if hand['hand_idx'] == hand_idx), None)
                                if rotation_hand_info:
                                    obj_3d.last_rotation_hand_pos = rotation_hand_info['palm_center']
                                self._update_rotation_axis_from_hand(obj_3d, hands_info)
                                
                                print(f"Object entered rotation mode - Hand {hand_idx} controlling rotation")
                                
                                # Remove this hand from grabbed_by_hand but keep it in grab_states_3d for rotation tracking
                                if hand_idx in obj_3d.grabbed_by_hand:
                                    obj_3d.grabbed_by_hand.remove(hand_idx)
                                obj_3d.is_grabbed = len(obj_3d.grabbed_by_hand)
                                
                                # Clear scaling state
                                if 'initial_two_hand_distance' in grab_state:
                                    del grab_state['initial_two_hand_distance']
                                if 'initial_scale' in grab_state:
                                    del grab_state['initial_scale']
                                
                                # Don't delete from grab_states_3d - keep for rotation tracking
                                continue
                    
                    # Normal release logic (not transitioning to rotation mode)
                    # Remove this hand from the grabbed_by_hand list
                    if hand_idx in obj_3d.grabbed_by_hand:
                        obj_3d.grabbed_by_hand.remove(hand_idx)
                    # Update grab state based on remaining hands
                    obj_3d.is_grabbed = len(obj_3d.grabbed_by_hand)
                    
                    # Handle rotation mode exit if this hand was controlling rotation
                    if obj_3d.is_in_rotation_mode and obj_3d.rotation_hand_idx == hand_idx:
                        self._exit_rotation_mode(obj_3d)
                    
                    # Deselect object when completely released
                    if obj_3d.is_grabbed == 0:
                        obj_3d.selected = False
                        obj_3d.is_in_rotation_mode = False
                        obj_3d.rotation_hand_idx = None
                        obj_3d.last_rotation_hand_pos = None
                    
                    # Reset scaling state if transitioning from two-hand to one-hand or no hands
                    if obj_3d.is_grabbed < 2:
                        # Clear two-hand scaling state from all hands grabbing this object
                        for other_hand_idx in obj_3d.grabbed_by_hand:
                            if other_hand_idx in self.grab_states_3d:
                                other_hand_state = self.grab_states_3d[other_hand_idx]
                                if 'initial_two_hand_distance' in other_hand_state:
                                    del other_hand_state['initial_two_hand_distance']
                                if 'initial_scale' in other_hand_state:
                                    del other_hand_state['initial_scale']
                    
                    # Only delete if the hand is still in grab_states_3d (might have been removed by rotation mode logic)
                    if hand_idx in self.grab_states_3d:
                        del self.grab_states_3d[hand_idx]
        
        
        # Clean up grab states for hands that are no longer detected
        hands_to_remove = []
        for hand_idx in self.grab_states:
            if hand_idx not in current_grabs:
                obj = self.grab_states[hand_idx]['object']
                # Remove this hand from the grabbed_by_hand list
                if hand_idx in obj.grabbed_by_hand:
                    obj.grabbed_by_hand.remove(hand_idx)
                # Update grab state based on remaining hands
                obj.is_grabbed = len(obj.grabbed_by_hand)
                
                # Reset scaling state if transitioning from two-hand to one-hand or no hands
                if obj.is_grabbed < 2:
                    # Clear two-hand scaling state from all hands grabbing this object
                    for other_hand_idx in obj.grabbed_by_hand:
                        if other_hand_idx in self.grab_states:
                            other_hand_state = self.grab_states[other_hand_idx]
                            if 'initial_two_hand_distance' in other_hand_state:
                                del other_hand_state['initial_two_hand_distance']
                            if 'initial_size' in other_hand_state:
                                del other_hand_state['initial_size']
                
                hands_to_remove.append(hand_idx)
        
        for hand_idx in hands_to_remove:
            del self.grab_states[hand_idx]
            # Also clean up pinch state
            if hand_idx in self.pinch_states:
                del self.pinch_states[hand_idx]
        
        # Clean up 3D grab states
        hands_to_remove_3d = []
        for hand_idx in self.grab_states_3d:
            if hand_idx not in current_grabs_3d:
                obj_3d = self.grab_states_3d[hand_idx]['object']
                # Remove this hand from the grabbed_by_hand list
                if hand_idx in obj_3d.grabbed_by_hand:
                    obj_3d.grabbed_by_hand.remove(hand_idx)
                # Update grab state based on remaining hands
                obj_3d.is_grabbed = len(obj_3d.grabbed_by_hand)
                
                # Reset scaling state if transitioning from two-hand to one-hand or no hands
                if obj_3d.is_grabbed < 2:
                    # Clear two-hand scaling state from all hands grabbing this object
                    for other_hand_idx in obj_3d.grabbed_by_hand:
                        if other_hand_idx in self.grab_states_3d:
                            other_hand_state = self.grab_states_3d[other_hand_idx]
                            if 'initial_two_hand_distance' in other_hand_state:
                                del other_hand_state['initial_two_hand_distance']
                            if 'initial_scale' in other_hand_state:
                                del other_hand_state['initial_scale']
                
                hands_to_remove_3d.append(hand_idx)
        
        for hand_idx in hands_to_remove_3d:
            del self.grab_states_3d[hand_idx]
        
        # Handle selection mode interactions for 3D objects
        if self.show_3d_objects:
            self._handle_selection_mode_3d(hands_info)
        
        # Clean up rotation mode for objects that are no longer grabbed
        for obj_3d in self.objects_3d:
            if obj_3d.is_in_rotation_mode and obj_3d.is_grabbed == 0:
                self._exit_rotation_mode(obj_3d)
        
        # Clean up rotation mode for hands that are no longer detected
        for obj_3d in self.objects_3d:
            if obj_3d.is_in_rotation_mode and obj_3d.rotation_hand_idx is not None:
                # Check if rotation hand is still detected
                rotation_hand_detected = any(hand['hand_idx'] == obj_3d.rotation_hand_idx for hand in hands_info)
                if not rotation_hand_detected:
                    self._exit_rotation_mode(obj_3d)
        
        # Additional safety: release objects if no hands are detected
        if not hands_info:
            for obj in self.objects:
                if obj.is_grabbed > 0:
                    obj.is_grabbed = 0
                    obj.grabbed_by_hand = []
            for obj_3d in self.objects_3d:
                if obj_3d.is_grabbed > 0:
                    obj_3d.is_grabbed = 0
                    obj_3d.grabbed_by_hand = []
            self.grab_states.clear()
            self.grab_states_3d.clear()
            self.pinch_states.clear()
    
    def _handle_pinch_interaction(self, hand_info: dict, hand_idx: int):
        """Handle pinch gesture interaction with improved tracking"""
        pinch_center = hand_info['pinch_center']
        pinch_distance = hand_info['pinch_distance']
        
        if hand_idx not in self.grab_states:
            # Try to grab an object - use pinch center for better accuracy
            closest_obj = None
            closest_distance = float('inf')
            
            for obj in self.objects:
                if obj.is_grabbed < 2:  # Allow grabbing if not already grabbed by 2 hands
                    # Use actual object size for grab radius to match pinchable radius
                    grab_radius = obj.size
                    distance = math.sqrt((obj.x - pinch_center[0]) ** 2 + (obj.y - pinch_center[1]) ** 2)
                    if distance <= grab_radius and distance < closest_distance:
                        closest_distance = distance
                        closest_obj = obj
            
            if closest_obj:
                # Add this hand to the grabbed_by_hand list
                if hand_idx not in closest_obj.grabbed_by_hand:
                    closest_obj.grabbed_by_hand.append(hand_idx)
                # Update grab state based on number of hands
                closest_obj.is_grabbed = len(closest_obj.grabbed_by_hand)
                # Mark object as selected when grabbed
                closest_obj.selected = True
                self.grab_states[hand_idx] = {
                    'object': closest_obj,
                    'initial_pinch_distance': pinch_distance,
                    'initial_size': closest_obj.size,
                    'grab_offset_x': pinch_center[0] - closest_obj.x,
                    'grab_offset_y': pinch_center[1] - closest_obj.y
                }
        else:
            # Continue interaction with grabbed object
            grab_state = self.grab_states[hand_idx]
            obj = grab_state['object']
            
            # Move object with offset for natural feel
            target_x = pinch_center[0] - grab_state['grab_offset_x']
            target_y = pinch_center[1] - grab_state['grab_offset_y']
            obj.move_to(target_x, target_y)
            
            # Only scale if object is grabbed by two hands
            if obj.is_grabbed == 2:
                self._handle_two_hand_scaling_2d(obj)
    
    def _handle_two_hand_scaling_2d(self, obj):
        """Handle scaling when 2D object is grabbed by two hands"""
        # Get the two hands that are grabbing this object
        grabbing_hands = [hand_idx for hand_idx in obj.grabbed_by_hand if hand_idx in self.grab_states]
        
        if len(grabbing_hands) == 2:
            hand1_idx, hand2_idx = grabbing_hands[0], grabbing_hands[1]
            hand1_state = self.grab_states[hand1_idx]
            hand2_state = self.grab_states[hand2_idx]
            
            # Get current hand positions from the detector
            hand1_info = None
            hand2_info = None
            
            for hand_info in self.current_hands_info:
                if hand_info['hand_idx'] == hand1_idx:
                    hand1_info = hand_info
                elif hand_info['hand_idx'] == hand2_idx:
                    hand2_info = hand_info
            
            if hand1_info and hand2_info:
                # Calculate current distance between the two hands using pinch centers
                hand1_pos = hand1_info['pinch_center']
                hand2_pos = hand2_info['pinch_center']
                current_distance = math.sqrt((hand2_pos[0] - hand1_pos[0]) ** 2 + (hand2_pos[1] - hand1_pos[1]) ** 2)
                
                # Get initial distance when two-hand grab started
                if 'initial_two_hand_distance' not in hand1_state:
                    # Initialize the two-hand scaling
                    hand1_state['initial_two_hand_distance'] = current_distance
                    hand1_state['initial_size'] = obj.size
                    hand2_state['initial_two_hand_distance'] = current_distance
                    hand2_state['initial_size'] = obj.size
                
                initial_distance = hand1_state['initial_two_hand_distance']
                
                # Calculate scale factor based on distance change
                if initial_distance > 0:
                    scale_factor = current_distance / initial_distance
                    target_size = hand1_state['initial_size'] * scale_factor
                    
                    # Apply scaling with smoothing
                    obj.size = obj.size * 0.7 + target_size * 0.3  # Smooth scaling
                    obj.size = max(20, min(200, obj.size))  # Clamp size
    
    
    def _handle_selection_mode_3d(self, hands_info: List[dict]):
        """Handle selection mode interactions for 3D objects (two-hand selection)"""
        # Update selection mode objects based on current grab states
        self._update_selection_mode_objects()
        
        # Handle interactions for objects in selection mode
        for obj_3d in self.selection_mode_objects:
            self._handle_selection_mode_interactions(obj_3d, hands_info)
        
        # Handle rotation mode for objects that transitioned from 2-hand to 1-hand grabbing
        self._handle_rotation_mode_3d(hands_info)
    
    def _update_selection_mode_objects(self):
        """Update which objects are in selection mode (grabbed by exactly 2 hands)"""
        # Clear current selection mode
        self.selection_mode_objects.clear()
        
        # Add objects that are grabbed by exactly 2 hands
        for obj_3d in self.objects_3d:
            if obj_3d.is_grabbed == 2:
                self.selection_mode_objects.add(obj_3d)
                obj_3d.is_selected = True  # Mark as selected for visual feedback
            else:
                obj_3d.is_selected = False  # Clear selection state
    
    def _handle_selection_mode_interactions(self, obj_3d, hands_info: List[dict]):
        """Handle scaling for objects in selection mode (2 hands grabbing)"""
        # Get the two hands that are currently grabbing this object
        grabbing_hands = [hand_idx for hand_idx in obj_3d.grabbed_by_hand if hand_idx in self.grab_states_3d]
        
        if len(grabbing_hands) == 2:
            hand1_idx, hand2_idx = grabbing_hands[0], grabbing_hands[1]
            
            # Check if both hands are still pinching (scaling mode)
            hand1_pinching = any(hand['hand_idx'] == hand1_idx and hand['is_pinching'] for hand in hands_info)
            hand2_pinching = any(hand['hand_idx'] == hand2_idx and hand['is_pinching'] for hand in hands_info)
            
            if hand1_pinching and hand2_pinching:
                # Both hands pinching - scaling mode
                self._handle_selection_scaling(obj_3d, hand1_idx, hand2_idx, hands_info)
            elif hand1_pinching or hand2_pinching:
                # One hand released - transition to rotation mode
                self._transition_to_rotation_mode(obj_3d, hand1_idx, hand2_idx, hands_info)
    
    def _handle_selection_scaling(self, obj_3d, hand1_idx: int, hand2_idx: int, hands_info: List[dict]):
        """Handle scaling when both hands are pinching in selection mode"""
        # Get hand positions
        hand1_info = next((hand for hand in hands_info if hand['hand_idx'] == hand1_idx), None)
        hand2_info = next((hand for hand in hands_info if hand['hand_idx'] == hand2_idx), None)
        
        if hand1_info and hand2_info:
            # Calculate current distance between the two hands
            hand1_pos = hand1_info['pinch_center']
            hand2_pos = hand2_info['pinch_center']
            current_distance = math.sqrt((hand2_pos[0] - hand1_pos[0]) ** 2 + (hand2_pos[1] - hand1_pos[1]) ** 2)
            
            # Get initial distance when two-hand grab started
            hand1_state = self.grab_states_3d[hand1_idx]
            if 'initial_two_hand_distance' not in hand1_state:
                hand1_state['initial_two_hand_distance'] = current_distance
                hand1_state['initial_scale'] = obj_3d.scale
            
            initial_distance = hand1_state['initial_two_hand_distance']
            
            # Calculate scale factor based on distance change
            if initial_distance > 0:
                scale_factor = current_distance / initial_distance
                target_scale = hand1_state['initial_scale'] * scale_factor
                
                # Apply scaling with smoothing
                obj_3d.scale = obj_3d.scale * 0.7 + target_scale * 0.3  # Smooth scaling
                obj_3d.scale = max(0.1, min(5.0, obj_3d.scale))  # Clamp scale
    
    
    def _transition_to_rotation_mode(self, obj_3d, hand1_idx: int, hand2_idx: int, hands_info: List[dict]):
        """Transition object to rotation mode when one hand releases from 2-hand grab"""
        # Determine which hand is still pinching and which is released
        hand1_pinching = any(hand['hand_idx'] == hand1_idx and hand['is_pinching'] for hand in hands_info)
        hand2_pinching = any(hand['hand_idx'] == hand2_idx and hand['is_pinching'] for hand in hands_info)
        
        if hand1_pinching and not hand2_pinching:
            # Hand1 still pinching, Hand2 released - Hand2 controls rotation
            rotation_hand = hand2_idx
        elif hand2_pinching and not hand1_pinching:
            # Hand2 still pinching, Hand1 released - Hand1 controls rotation
            rotation_hand = hand1_idx
        else:
            # Both hands released or both still pinching - no rotation mode
            return
        
        # Set rotation mode
        obj_3d.is_in_rotation_mode = True
        obj_3d.rotation_hand_idx = rotation_hand
        
        # Get initial position of rotation hand
        rotation_hand_info = next((hand for hand in hands_info if hand['hand_idx'] == rotation_hand), None)
        if rotation_hand_info:
            obj_3d.last_rotation_hand_pos = rotation_hand_info['palm_center']
        self._update_rotation_axis_from_hand(obj_3d, hands_info)
        
        print(f"Object entered rotation mode - Hand {rotation_hand} controlling rotation")
    
    def _update_rotation_axis_from_hand(self, obj_3d, hands_info: List[dict]):
        """Set the active rotation axis based on the controlling hand's handedness"""
        if obj_3d.rotation_hand_idx is None:
            obj_3d.rotation_axis = None
            return

        rotation_hand_info = next((hand for hand in hands_info if hand['hand_idx'] == obj_3d.rotation_hand_idx), None)
        if not rotation_hand_info:
            obj_3d.rotation_axis = None
            return

        label = rotation_hand_info.get('hand_label', 'unknown')
        if label == 'left':
            obj_3d.rotation_axis = 'x'
        elif label == 'right':
            obj_3d.rotation_axis = 'y'
        else:
            obj_3d.rotation_axis = None

    def _handle_rotation_mode_3d(self, hands_info: List[dict]):
        """Handle rotation mode for 3D objects"""
        for obj_3d in self.objects_3d:
            if obj_3d.is_in_rotation_mode and obj_3d.rotation_hand_idx is not None:
                # Refresh rotation axis in case handedness changed ordering
                self._update_rotation_axis_from_hand(obj_3d, hands_info)

                rotation_hand_info = next((hand for hand in hands_info if hand['hand_idx'] == obj_3d.rotation_hand_idx), None)
                if not rotation_hand_info:
                    self._exit_rotation_mode(obj_3d)
                    continue

                current_pos = rotation_hand_info['palm_center']
                if obj_3d.last_rotation_hand_pos is None:
                    obj_3d.last_rotation_hand_pos = current_pos
                    continue

                # Keep rotation intentional: ignore if the controlling hand is still pinching
                if rotation_hand_info.get('is_pinching', False):
                    obj_3d.last_rotation_hand_pos = current_pos
                    continue

                # Optional guard: avoid rotating when fist is detected
                gestures = rotation_hand_info.get('gestures', [])
                if 'fist' in gestures and 'open_hand' not in gestures:
                    obj_3d.last_rotation_hand_pos = current_pos
                    continue

                last_pos = obj_3d.last_rotation_hand_pos
                delta_x = current_pos[0] - last_pos[0]
                delta_y = current_pos[1] - last_pos[1]
                movement_threshold = 4
                rotation_sensitivity = 0.01
                axis = getattr(obj_3d, 'rotation_axis', None)

                if axis == 'x':
                    if abs(delta_y) > movement_threshold:
                        obj_3d.rotation_x -= delta_y * rotation_sensitivity
                        obj_3d.rotation_x = obj_3d.rotation_x % (2 * math.pi)
                else:
                    if abs(delta_x) > movement_threshold:
                        obj_3d.rotation_y -= delta_x * rotation_sensitivity
                        obj_3d.rotation_y = obj_3d.rotation_y % (2 * math.pi)

                obj_3d.last_rotation_hand_pos = current_pos
            else:
                if obj_3d.is_in_rotation_mode:
                    self._exit_rotation_mode(obj_3d)
    
    def _exit_rotation_mode(self, obj_3d):
        """Exit rotation mode for an object"""
        # Clean up the rotation hand's grab state if it exists
        if obj_3d.rotation_hand_idx is not None and obj_3d.rotation_hand_idx in self.grab_states_3d:
            del self.grab_states_3d[obj_3d.rotation_hand_idx]
        
        obj_3d.is_in_rotation_mode = False
        obj_3d.rotation_hand_idx = None
        obj_3d.last_rotation_hand_pos = None
        obj_3d.rotation_axis = None
        print(f"Object exited rotation mode")
                
    
    def _handle_pinch_interaction_3d(self, hand_info: dict, hand_idx: int) -> bool:
        """Handle pinch gesture interaction with 3D objects with improved tracking"""
        pinch_center = hand_info['pinch_center']
        pinch_distance = hand_info['pinch_distance']
        thumb_pos = hand_info['thumb_pos']
        index_pos = hand_info['index_pos']
        
        if hand_idx not in self.grab_states_3d:
            # Try to grab a 3D object
            closest_obj_3d = None
            closest_distance = float('inf')
            
            for obj_3d in self.objects_3d:
                if obj_3d.is_grabbed < 2 and obj_3d.is_point_inside(pinch_center[0], pinch_center[1], self.renderer_3d):
                    # For 3D objects, we use a simpler distance check
                    distance = 0  # If point is inside, it's the closest
                    if distance < closest_distance:
                        closest_distance = distance
                        closest_obj_3d = obj_3d
            
            if closest_obj_3d:
                # Add this hand to the grabbed_by_hand list
                if hand_idx not in closest_obj_3d.grabbed_by_hand:
                    closest_obj_3d.grabbed_by_hand.append(hand_idx)
                # Update grab state based on number of hands
                closest_obj_3d.is_grabbed = len(closest_obj_3d.grabbed_by_hand)
                # Mark object as selected when grabbed
                closest_obj_3d.selected = True
                
                # Get the current 3D object's screen position for calculating grab offset
                current_screen_pos = closest_obj_3d.get_screen_position(self.renderer_3d)
                
                self.grab_states_3d[hand_idx] = {
                    'object': closest_obj_3d,
                    'initial_pinch_distance': pinch_distance,
                    'initial_scale': closest_obj_3d.scale,
                    'initial_world_pos': (closest_obj_3d.x, closest_obj_3d.y, closest_obj_3d.z),
                    'grab_offset_x': pinch_center[0] - current_screen_pos[0] if current_screen_pos else 0,
                    'grab_offset_y': pinch_center[1] - current_screen_pos[1] if current_screen_pos else 0,
                    'last_pinch_center': pinch_center,
                    'last_thumb_pos': thumb_pos,
                    'last_index_pos': index_pos,
                    'movement_sensitivity': 0.015,  # Controls how much screen movement affects 3D position (increased for better responsiveness)
                    'initial_rotation': (closest_obj_3d.rotation_x, closest_obj_3d.rotation_y, closest_obj_3d.rotation_z),
                    'rotation_sensitivity': 0.01  # Controls rotation sensitivity
                }
                return True
        else:
            # Continue interaction with grabbed 3D object
            grab_state = self.grab_states_3d[hand_idx]
            obj_3d = grab_state['object']
            
            # Only move the object if the hand has actually moved
            last_pinch_center = grab_state['last_pinch_center']
            pinch_delta_x = pinch_center[0] - last_pinch_center[0]
            pinch_delta_y = pinch_center[1] - last_pinch_center[1]
            
            # Calculate movement magnitude to determine if hand actually moved
            movement_magnitude = math.sqrt(pinch_delta_x**2 + pinch_delta_y**2)
            movement_threshold = 0.5  # pixels - minimum movement to trigger object movement (reduced for better responsiveness)
            
            if movement_magnitude > movement_threshold:
                # Convert screen movement to world space movement
                sensitivity = grab_state['movement_sensitivity']
                world_delta_x = pinch_delta_x * sensitivity
                world_delta_y = -pinch_delta_y * sensitivity  # Invert Y for correct direction
                
                # Apply movement directly without smoothing for immediate response
                obj_3d.x += world_delta_x
                obj_3d.y += world_delta_y
            
            
            # Track finger positions for better interaction feedback
            grab_state['last_pinch_center'] = pinch_center
            grab_state['last_thumb_pos'] = thumb_pos
            grab_state['last_index_pos'] = index_pos
            
            return True
        
        return False
    
    
    def _add_random_object(self):
        """Add a new random object"""
        import random
        x = random.randint(100, 600)
        y = random.randint(100, 400)
        size = random.randint(40, 80)
        color = (random.randint(50, 255), random.randint(50, 255), random.randint(50, 255))
        shape = random.choice(["circle", "cube"])
        
        self.objects.append(VirtualObject(x, y, size, color, shape))
    
    def _draw_ui(self, frame: np.ndarray, hands_info: List[dict]) -> np.ndarray:
        """Draw user interface elements"""
        # Draw instructions
        instructions = [
            "AR Hand Control - Pinch to grab, move, and scale objects",
            "Two hands required for scaling - move apart/closer to scale",
            "Q: Quit | R: Reset | C: Add Object",
            f"Objects: {len(self.objects)} | Hands: {len(hands_info)}"
        ]
        
        for i, instruction in enumerate(instructions):
            y_pos = 30 + i * 25
            cv2.putText(frame, instruction, (10, y_pos), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        # Draw hand status with pinch feedback
        for hand_info in hands_info:
            hand_idx = hand_info['hand_idx']
            palm_pos = hand_info['palm_center']
            pinch_center = hand_info['pinch_center']
            
            # Draw palm center
            cv2.circle(frame, palm_pos, 8, (0, 255, 0), -1)
            
            # Draw pinch center
            cv2.circle(frame, pinch_center, 5, (255, 0, 255), -1)
            
            # Show pinch status with more detail
            is_pinching = hand_info['is_pinching']
            stabilized_pinching = hand_idx in self.pinch_states and self.pinch_states[hand_idx]['was_pinching']
            
            if stabilized_pinching:
                status = "PINCHING ✓"
                color = (0, 255, 0)  # Green for successful pinch
                if hand_idx in self.grab_states:
                    obj = self.grab_states[hand_idx]['object']
                    grab_state_text = ["Not grabbed", "1 hand", "2 hands"][obj.is_grabbed]
                    scaling_text = " (SCALING)" if obj.is_grabbed == 2 else ""
                    status = f"2D GRABBED ✓ ({grab_state_text}{scaling_text}, Size: {int(obj.size)})"
                    color = (255, 255, 0)  # Yellow for grabbed 2D
                elif hand_idx in self.grab_states_3d:
                    obj_3d = self.grab_states_3d[hand_idx]['object']
                    grab_state_text = ["Not grabbed", "1 hand", "2 hands"][obj_3d.is_grabbed]
                    scaling_text = " (SCALING)" if obj_3d.is_grabbed == 2 else ""
                    rotation_text = f" (ROTATING - Hand {obj_3d.rotation_hand_idx})" if obj_3d.is_in_rotation_mode else ""
                    status = f"3D GRABBED ✓ ({grab_state_text}{scaling_text}{rotation_text}, Scale: {obj_3d.scale:.1f})"
                    color = (0, 255, 255)  # Cyan for grabbed 3D
            elif is_pinching:
                status = "PINCHING..."
                color = (0, 255, 255)  # Cyan for detecting
            else:
                status = "OPEN"
                color = (128, 128, 128)  # Gray for open
            
            cv2.putText(frame, f"Hand {hand_idx}: {status}", 
                       (palm_pos[0] - 60, palm_pos[1] - 25),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            # Show pinch distance
            pinch_distance = hand_info['pinch_distance']
            cv2.putText(frame, f"Distance: {int(pinch_distance)}", 
                       (palm_pos[0] - 30, palm_pos[1] + 15),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        
        # Show object counts and mode info
        info_y = frame.shape[0] - 80
        cv2.putText(frame, f"2D Objects: {len(self.objects)} {'(ON)' if self.show_2d_objects else '(OFF)'}", 
                   (10, info_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(frame, f"3D Objects: {len(self.objects_3d)} {'(ON)' if self.show_3d_objects else '(OFF)'}", 
                   (10, info_y + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        if self.objects_3d:
            render_mode = self.objects_3d[0].render_mode
            auto_rotate = self.objects_3d[0].auto_rotate
            cv2.putText(frame, f"3D Mode: {render_mode} | Auto-rotate: {'ON' if auto_rotate else 'OFF'}", 
                       (10, info_y + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        return frame
    
    def _draw_rotation_hand_indicators(self, frame: np.ndarray, hands_info: List[dict]) -> np.ndarray:
        """Draw visual indicators for hands controlling rotation"""
        for obj_3d in self.objects_3d:
            if obj_3d.is_in_rotation_mode and obj_3d.rotation_hand_idx is not None:
                # Find the rotation hand
                rotation_hand_info = next((hand for hand in hands_info if hand['hand_idx'] == obj_3d.rotation_hand_idx), None)
                
                if rotation_hand_info:
                    # Draw a large circle around the rotation hand
                    hand_center = rotation_hand_info['palm_center']
                    cv2.circle(frame, hand_center, 30, (0, 255, 255), 3)  # Cyan circle
                    cv2.circle(frame, hand_center, 25, (0, 255, 255), -1)  # Filled cyan circle
                    
                    # Choose label based on active axis for quick user feedback
                    axis = getattr(obj_3d, 'rotation_axis', None)
                    if axis == 'x':
                        text = "ROTATE X"
                    elif axis == 'y':
                        text = "ROTATE Y"
                    else:
                        text = "ROTATOR"
                    font = cv2.FONT_HERSHEY_SIMPLEX
                    font_scale = 0.6
                    font_thickness = 2
                    text_size = cv2.getTextSize(text, font, font_scale, font_thickness)[0]
                    text_x = hand_center[0] - text_size[0] // 2
                    text_y = hand_center[1] - 40
                    
                    # Draw text background
                    cv2.rectangle(frame, 
                                (text_x - 5, text_y - text_size[1] - 5), 
                                (text_x + text_size[0] + 5, text_y + 5), 
                                (0, 0, 0), -1)
                    
                    # Draw text
                    cv2.putText(frame, text, (text_x, text_y), font, font_scale, (0, 255, 255), font_thickness)
                    
                    # Draw directional hints based on axis mapping
                    arrow_color = (0, 255, 255)
                    arrow_length = 35
                    if axis == 'x':
                        # Up/down arrows for X-axis tilt
                        cv2.arrowedLine(
                            frame,
                            (hand_center[0], hand_center[1] - 10),
                            (hand_center[0], hand_center[1] - 10 - arrow_length),
                            arrow_color,
                            3,
                            tipLength=0.3,
                        )
                        cv2.arrowedLine(
                            frame,
                            (hand_center[0], hand_center[1] + 10),
                            (hand_center[0], hand_center[1] + 10 + arrow_length),
                            arrow_color,
                            3,
                            tipLength=0.3,
                        )
                        cv2.putText(frame, "UP", (hand_center[0] - 20, hand_center[1] - 15 - arrow_length), font, 0.4, arrow_color, 1)
                        cv2.putText(frame, "DOWN", (hand_center[0] - 30, hand_center[1] + 25 + arrow_length), font, 0.4, arrow_color, 1)
                    else:
                        # Left/right arrows for Y-axis yaw
                        arrow_x = hand_center[0] + 50
                        arrow_y = hand_center[1]
                        cv2.arrowedLine(
                            frame,
                            (arrow_x + arrow_length, arrow_y),
                            (arrow_x, arrow_y),
                            arrow_color,
                            3,
                            tipLength=0.3,
                        )
                        cv2.arrowedLine(
                            frame,
                            (arrow_x, arrow_y),
                            (arrow_x + arrow_length, arrow_y),
                            arrow_color,
                            3,
                            tipLength=0.3,
                        )
                        cv2.putText(frame, "CW", (arrow_x - 15, arrow_y - 10), font, 0.4, arrow_color, 1)
                        cv2.putText(frame, "CCW", (arrow_x + arrow_length - 5, arrow_y - 10), font, 0.4, arrow_color, 1)
        
        return frame
    
    def _cleanup(self):
        """Clean up resources"""
        if self.cap:
            self.cap.release()
        cv2.destroyAllWindows()


def main():
    """Main function to run the AR hand control application"""
    try:
        app = ARHandController()
        app.start()
    except KeyboardInterrupt:
        print("\nApplication stopped by user")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
