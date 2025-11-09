// Configuration - Auto-detect signaling server
let SIGNALING_SERVER = 'http://localhost:3001';

// Auto-detect if we're being served from ngrok or a remote server
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    // We're on a remote server (ngrok), use the same origin
    SIGNALING_SERVER = window.location.origin;
    console.log('Auto-detected server:', SIGNALING_SERVER);
} else {
    // We're on localhost, check for URL parameter or localStorage
    const urlParams = new URLSearchParams(window.location.search);
    const serverFromURL = urlParams.get('server');
    const serverFromStorage = localStorage.getItem('signalingServer');

    if (serverFromURL) {
        SIGNALING_SERVER = serverFromURL;
        localStorage.setItem('signalingServer', serverFromURL);
    } else if (serverFromStorage) {
        SIGNALING_SERVER = serverFromStorage;
    }
}

// Add server info and change button
window.addEventListener('DOMContentLoaded', () => {
    const serverInfo = document.createElement('div');
    serverInfo.style.cssText = 'position: fixed; bottom: 10px; left: 10px; background: rgba(0,0,0,0.7); color: white; padding: 10px; border-radius: 5px; font-size: 12px; z-index: 1000;';
    
    const isAutoDetected = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    
    if (isAutoDetected) {
        serverInfo.innerHTML = `🌐 Server: ${SIGNALING_SERVER} (auto-detected)`;
    } else {
        serverInfo.innerHTML = `🌐 Server: ${SIGNALING_SERVER}<br><button onclick="changeServer()" style="margin-top: 5px; padding: 5px; cursor: pointer;">Change Server</button>`;
    }
    
    document.body.appendChild(serverInfo);
});

window.changeServer = () => {
    const newServer = prompt(
        'Enter Signaling Server URL:\n\n' +
        'For localhost: http://localhost:3001\n' +
        'For ngrok: https://YOUR-ID.ngrok.io',
        SIGNALING_SERVER
    );
    if (newServer && newServer.trim()) {
        localStorage.setItem('signalingServer', newServer.trim());
        location.reload();
    }
};

// State
let socket = null;
let peerConnection = null;
let remoteStream = null;
let roomId = null;
let userName = null;
let currentTool = 'arrow';
let annotations = [];

// DOM Elements
const setupPanel = document.getElementById('setupPanel');
const consultationContainer = document.getElementById('consultationContainer');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const userNameInput = document.getElementById('userName');
const roomIdInput = document.getElementById('roomId');
const remoteVideo = document.getElementById('remoteVideo');
const annotationCanvas = document.getElementById('annotationCanvas');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const currentRoomId = document.getElementById('currentRoomId');
const streamStatus = document.getElementById('streamStatus');
const usersList = document.getElementById('usersList');
const videoStatus = document.getElementById('videoStatus');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');

// Tool buttons
const arrowBtn = document.getElementById('arrowBtn');
const textBtn = document.getElementById('textBtn');
const clearBtn = document.getElementById('clearBtn');
const textInputPanel = document.getElementById('textInputPanel');
const annotationText = document.getElementById('annotationText');
const addTextBtn = document.getElementById('addTextBtn');

// Event Listeners
joinBtn.addEventListener('click', joinSession);
leaveBtn.addEventListener('click', leaveSession);
toggleAudioBtn.addEventListener('click', toggleAudio);
arrowBtn.addEventListener('click', () => selectTool('arrow'));
textBtn.addEventListener('click', () => selectTool('text'));
clearBtn.addEventListener('click', clearAllAnnotations);
annotationCanvas.addEventListener('click', handleCanvasClick);
addTextBtn.addEventListener('click', addTextAnnotation);

// Hand Guidance state
let handGuidanceEnabled = false;
let handsLibLoaded = false;
let handsInstance = null;
let handCamera = null;
let handVideoEl = null;
let lastSkeletonSentAt = 0;
const HAND_SKELETON_FPS = 15; // throttle to ~15 fps

// Hand overlay canvas for expert view
let handOverlayCanvas = null;
let handOverlayCtx = null;
const HAND_CONNECTIONS = [
    // Thumb
    [0,1],[1,2],[2,3],[3,4],
    // Index
    [0,5],[5,6],[6,7],[7,8],
    // Middle
    [0,9],[9,10],[10,11],[11,12],
    // Ring
    [0,13],[13,14],[14,15],[15,16],
    // Pinky
    [0,17],[17,18],[18,19],[19,20],
    // Palm
    [5,9],[9,13],[13,17],[17,5]
];

// Initialize Socket.IO connection
function initializeSocket() {
    socket = io(SIGNALING_SERVER);

    socket.on('connect', () => {
        updateConnectionStatus(true);
        console.log('Connected to signaling server');
    });

    socket.on('disconnect', () => {
        updateConnectionStatus(false);
        console.log('Disconnected from signaling server');
    });

    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('room-users', handleRoomUsers);
}

// Join session
async function joinSession() {
    userName = userNameInput.value.trim();
    roomId = roomIdInput.value.trim();

    if (!userName || !roomId) {
        alert('Please enter your name and room ID');
        return;
    }

    // Initialize socket connection
    initializeSocket();

    // Join room
    socket.emit('join-room', {
        roomId,
        role: 'expert',
        userName
    });

    // Update UI
    setupPanel.style.display = 'none';
    consultationContainer.style.display = 'grid';
    currentRoomId.textContent = roomId;

    console.log('Joined session');

    // Optionally auto-enable Hand Guidance once joined (kept off by default)
    // enableHandGuidance().catch(() => {});
}

// Leave session
function leaveSession() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }

    // Stop hand guidance if running
    disableHandGuidance();

    if (socket) {
        socket.disconnect();
        socket = null;
    }

    setupPanel.style.display = 'block';
    consultationContainer.style.display = 'none';
    updateConnectionStatus(false);
    videoStatus.style.display = 'block';
    videoStatus.textContent = 'Waiting for video stream...';
}

// Toggle audio
function toggleAudio() {
    if (remoteStream) {
        const audioTrack = remoteStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            toggleAudioBtn.textContent = audioTrack.enabled ? '🔊 Audio On' : '🔇 Audio Off';
        }
    }
}

// Handle user joined
function handleUserJoined({ userId, role, userName }) {
    console.log(`User joined: ${userName} (${role})`);
    updateUsersList();
}

// Handle user left
function handleUserLeft({ userId, role, userName }) {
    console.log(`User left: ${userName} (${role})`);
    
    if (role === 'clinician') {
        videoStatus.style.display = 'block';
        videoStatus.textContent = 'Clinician disconnected';
        streamStatus.textContent = 'Disconnected';
        streamStatus.className = 'badge badge-warning';
    }
    
    updateUsersList();
}

// Handle offer from clinician
async function handleOffer({ offer, senderId }) {
    console.log('Received offer from:', senderId);
    
    peerConnection = createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', {
        answer,
        targetId: senderId
    });
}

// Handle answer (if we initiated)
async function handleAnswer({ answer, senderId }) {
    console.log('Received answer from:', senderId);
    
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
}

// Handle ICE candidate
async function handleIceCandidate({ candidate, senderId }) {
    if (peerConnection && candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

// Create peer connection
function createPeerConnection() {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Handle incoming tracks
    pc.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        
        if (!remoteStream) {
            remoteStream = new MediaStream();
        }
        
        remoteStream.addTrack(event.track);
        remoteVideo.srcObject = remoteStream;
        
        videoStatus.style.display = 'none';
        streamStatus.textContent = 'Connected';
        streamStatus.className = 'badge badge-success';
        
        // Resize canvas to match video
        resizeCanvas();
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: event.target.remoteUserId || null // Will be set properly in production
            });
        }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
            streamStatus.textContent = 'Connected';
            streamStatus.className = 'badge badge-success';
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            streamStatus.textContent = 'Disconnected';
            streamStatus.className = 'badge badge-warning';
            videoStatus.style.display = 'block';
            videoStatus.textContent = 'Connection lost';
        }
    };

    return pc;
}

// Handle room users
function handleRoomUsers(users) {
    console.log('Room users:', users);
    updateUsersList();
}

// Update users list
function updateUsersList() {
    // This would be enhanced with actual user tracking
    usersList.innerHTML = `
        <div class="user-item">
            <span class="user-icon">🏥</span>
            <div>
                <strong>Clinician</strong>
                <div style="font-size: 12px; color: #666;">Online</div>
            </div>
        </div>
    `;
}

// Tool selection
function selectTool(tool) {
    currentTool = tool;
    
    // Update active button
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (tool === 'arrow') {
        arrowBtn.classList.add('active');
        textInputPanel.style.display = 'none';
    } else if (tool === 'text') {
        textBtn.classList.add('active');
        textInputPanel.style.display = 'flex';
    }
}

// Handle canvas click
function handleCanvasClick(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;

    if (currentTool === 'arrow') {
        sendAnnotation({
            type: 'arrow',
            x: x,
            y: y
        });
    } else if (currentTool === 'text' && annotationText.value.trim()) {
        sendAnnotation({
            type: 'text',
            x: x,
            y: y,
            text: annotationText.value.trim()
        });
        annotationText.value = '';
    }
}

// Add text annotation (button click)
function addTextAnnotation() {
    if (annotationText.value.trim()) {
        // Place in center of video
        sendAnnotation({
            type: 'text',
            x: 50,
            y: 50,
            text: annotationText.value.trim()
        });
        annotationText.value = '';
    }
}

// Send annotation to clinician
function sendAnnotation(annotation) {
    if (!socket) return;
    
    socket.emit('annotation', {
        roomId,
        annotation
    });
    
    // Display locally
    displayAnnotation(annotation);
}

// Display annotation on canvas
function displayAnnotation(annotation) {
    const annotationDiv = document.createElement('div');
    annotationDiv.className = 'annotation';
    annotationDiv.style.left = annotation.x + '%';
    annotationDiv.style.top = annotation.y + '%';
    annotationDiv.style.position = 'absolute';

    if (annotation.type === 'arrow') {
        annotationDiv.innerHTML = '<div class="annotation-arrow">👇</div>';
    } else if (annotation.type === 'text') {
        annotationDiv.innerHTML = `<div class="annotation-text-display">${annotation.text}</div>`;
    }

    // Add to canvas parent (the video wrapper)
    const videoWrapper = annotationCanvas.parentElement;
    videoWrapper.appendChild(annotationDiv);

    // Store annotation
    annotations.push(annotationDiv);

    // Remove after 5 seconds
    setTimeout(() => {
        annotationDiv.remove();
        annotations = annotations.filter(a => a !== annotationDiv);
    }, 5000);
}

// Clear all annotations
function clearAllAnnotations() {
    annotations.forEach(annotation => annotation.remove());
    annotations = [];
    
    if (socket) {
        socket.emit('clear-annotations', { roomId });
    }
}

// Resize canvas to match video
function resizeCanvas() {
    const video = remoteVideo;
    annotationCanvas.width = video.videoWidth || video.clientWidth;
    annotationCanvas.height = video.videoHeight || video.clientHeight;
}

// Update connection status
function updateConnectionStatus(connected) {
    const dot = connectionStatus.querySelector('.dot');
    if (connected) {
        dot.classList.remove('offline');
        dot.classList.add('online');
        statusText.textContent = 'Connected';
    } else {
        dot.classList.remove('online');
        dot.classList.add('offline');
        statusText.textContent = 'Disconnected';
    }
}

// Resize canvas when video loads
remoteVideo.addEventListener('loadedmetadata', resizeCanvas);
window.addEventListener('resize', resizeCanvas);

// -----------------------------
// Hand Guidance (MediaPipe Hands)
// -----------------------------

function createHandGuidanceUI() {
    const ui = document.createElement('div');
    ui.style.cssText = 'position: fixed; bottom: 10px; right: 10px; background: rgba(0,0,0,0.7); color: white; padding: 10px; border-radius: 5px; font-size: 12px; z-index: 1000; display: flex; gap: 8px; align-items: center;';
    ui.id = 'handGuidancePanel';
    const label = document.createElement('span');
    label.textContent = '✋ Hand Guidance';
    const btn = document.createElement('button');
    btn.id = 'toggleHandGuidanceBtn';
    btn.textContent = 'Enable';
    btn.style.cssText = 'padding: 5px 8px; cursor: pointer;';
    btn.addEventListener('click', async () => {
        if (!roomId) {
            alert('Join a room first to use Hand Guidance.');
            return;
        }
        if (handGuidanceEnabled) {
            disableHandGuidance();
        } else {
            try {
                await enableHandGuidance();
            } catch (e) {
                console.error('Failed to enable hand guidance:', e);
                alert('Failed to enable Hand Guidance. Please allow camera permission and try again.');
            }
        }
        btn.textContent = handGuidanceEnabled ? 'Disable' : 'Enable';
    });
    ui.appendChild(label);
    ui.appendChild(btn);
    document.body.appendChild(ui);
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function loadHandsLibrary() {
    if (handsLibLoaded) return;
    // Load classic MediaPipe Hands libs from CDN
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    handsLibLoaded = true;
}

async function enableHandGuidance() {
    if (handGuidanceEnabled) return;
    await loadHandsLibrary();

    // Create hidden video element for hand camera
    if (!handVideoEl) {
        handVideoEl = document.createElement('video');
        handVideoEl.setAttribute('playsinline', '');
        handVideoEl.muted = true;
        handVideoEl.autoplay = true;
        handVideoEl.style.cssText = 'position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none;';
        handVideoEl.id = 'expertHandCam';
        document.body.appendChild(handVideoEl);
    }

    // Initialize MediaPipe Hands
    handsInstance = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });
    handsInstance.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.5
    });
    handsInstance.onResults(onHandsResults);

    // Camera from MediaPipe camera utils
    handCamera = new Camera(handVideoEl, {
        onFrame: async () => {
            if (!handsInstance) return;
            await handsInstance.send({ image: handVideoEl });
        },
        width: 640,
        height: 480
    });
    handCamera.start();

    handGuidanceEnabled = true;
}

function disableHandGuidance() {
    if (!handGuidanceEnabled) return;
    try {
        if (handCamera && handCamera.stop) {
            handCamera.stop();
        }
    } catch (e) {
        // ignore
    }
    handCamera = null;
    handsInstance = null;
    handGuidanceEnabled = false;
    // Clear hand overlay
    clearHandOverlay();
    // Notify clinician to clear overlay
    if (socket && roomId) {
        socket.emit('hand-skeleton', { roomId, skeleton: { clear: true, ts: Date.now() } });
    }
}

function extractHandInfo(landmarks, handedness) {
    // Extract detailed hand information like Python code
    const thumb_tip = landmarks[4];
    const index_tip = landmarks[8];
    const middle_tip = landmarks[12];
    const ring_tip = landmarks[16];
    const pinky_tip = landmarks[20];
    const wrist = landmarks[0];
    const index_mcp = landmarks[5];
    
    // Calculate positions (normalized 0-1, will be converted to pixels on display)
    const thumb_pos = { x: thumb_tip.x, y: thumb_tip.y };
    const index_pos = { x: index_tip.x, y: index_tip.y };
    const middle_pos = { x: middle_tip.x, y: middle_tip.y };
    const wrist_pos = { x: wrist.x, y: wrist.y };
    
    // Calculate palm center
    const palm_center = {
        x: (wrist.x + index_mcp.x) / 2,
        y: (wrist.y + index_mcp.y) / 2
    };
    
    // Calculate pinch distance (normalized)
    const pinch_distance = Math.sqrt(
        Math.pow(thumb_pos.x - index_pos.x, 2) + 
        Math.pow(thumb_pos.y - index_pos.y, 2)
    );
    
    // Calculate pinch center
    const pinch_center = {
        x: (thumb_pos.x + index_pos.x) / 2,
        y: (thumb_pos.y + index_pos.y) / 2
    };
    
    // Detect gestures
    const gestures = detectGestures(landmarks);
    
    // Pinch detection (same logic as Python code)
    const thumb_bent = thumb_tip.x < landmarks[3].x; // Thumb bent inward
    const index_bent = index_tip.y > landmarks[6].y; // Index finger bent down
    
    // Pinch detection with multiple criteria
    let is_pinching = (pinch_distance < 0.06 && // ~60 pixels at 1000px width
                      pinch_distance > 0.01 && // Not too close
                      (thumb_bent || index_bent || pinch_distance < 0.035));
    
    // Fallback: if very close, always consider pinching
    if (pinch_distance < 0.025) {
        is_pinching = true;
    }
    
    return {
        landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })),
        handedness: handedness || 'Unknown',
        thumb_pos,
        index_pos,
        middle_pos,
        palm_center,
        pinch_center,
        wrist_pos,
        gestures,
        pinch_distance,
        is_pinching,
        thumb_bent,
        index_bent
    };
}

function detectGestures(landmarks) {
    const gestures = [];
    const fingertips = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky
    const pip_joints = [3, 6, 10, 14, 18];
    
    const extended_fingers = [];
    
    // Thumb (special case - check x coordinate)
    if (landmarks[4].x > landmarks[3].x) {
        extended_fingers.push(true);
    } else {
        extended_fingers.push(false);
    }
    
    // Other fingers
    for (let i = 1; i < 5; i++) {
        if (landmarks[fingertips[i]].y < landmarks[pip_joints[i]].y) {
            extended_fingers.push(true);
        } else {
            extended_fingers.push(false);
        }
    }
    
    const extended_count = extended_fingers.filter(f => f).length;
    
    // Classify gestures
    if (extended_count === 0) {
        gestures.push("fist");
    } else if (extended_count === 1 && extended_fingers[1]) {
        gestures.push("pointing");
    } else if (extended_count === 2 && extended_fingers[0] && extended_fingers[1]) {
        gestures.push("pinch");
    } else if (extended_count === 5) {
        gestures.push("open_hand");
    } else if (extended_count === 2 && extended_fingers[1] && extended_fingers[2]) {
        gestures.push("peace");
    }
    
    return gestures;
}

function onHandsResults(results) {
    // Throttle send rate
    const now = Date.now();
    if (now - lastSkeletonSentAt < (1000 / HAND_SKELETON_FPS)) {
        return;
    }

    let payload;
    if (results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        // Process all detected hands (up to 2) with detailed information
        const hands = [];
        for (let i = 0; i < results.multiHandLandmarks.length && i < 2; i++) {
            const landmarks = results.multiHandLandmarks[i] || [];
            const handedness = (results.multiHandedness && results.multiHandedness[i] && results.multiHandedness[i].label) || null;
            
            // Extract detailed hand information
            const handInfo = extractHandInfo(landmarks, handedness);
            hands.push(handInfo);
        }
        payload = {
            hands: hands,
            ts: now
        };
    } else {
        // No hand detected
        payload = { clear: true, ts: now };
    }

    if (socket && roomId) {
        socket.emit('hand-skeleton', { roomId, skeleton: payload });
        lastSkeletonSentAt = now;
    }
    
    // Also draw hands on expert's view
    drawHandsOnExpertView(results);
}

function ensureHandOverlayCanvas() {
    if (!handOverlayCanvas) {
        const videoWrapper = remoteVideo.parentElement;
        if (!videoWrapper) return;
        
        handOverlayCanvas = document.createElement('canvas');
        handOverlayCanvas.id = 'expertHandOverlay';
        handOverlayCanvas.style.position = 'absolute';
        handOverlayCanvas.style.left = '0';
        handOverlayCanvas.style.top = '0';
        handOverlayCanvas.style.width = '100%';
        handOverlayCanvas.style.height = '100%';
        handOverlayCanvas.style.pointerEvents = 'none';
        handOverlayCanvas.style.zIndex = '10';
        videoWrapper.appendChild(handOverlayCanvas);
        handOverlayCtx = handOverlayCanvas.getContext('2d');
    }
    // Match canvas pixel size to video
    const rect = remoteVideo.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (handOverlayCanvas.width !== w || handOverlayCanvas.height !== h) {
        handOverlayCanvas.width = w;
        handOverlayCanvas.height = h;
    }
}

function clearHandOverlay() {
    if (!handOverlayCtx || !handOverlayCanvas) return;
    handOverlayCtx.clearRect(0, 0, handOverlayCanvas.width, handOverlayCanvas.height);
}

function drawHandsOnExpertView(results) {
    if (!handGuidanceEnabled || !results) {
        clearHandOverlay();
        return;
    }
    
    ensureHandOverlayCanvas();
    if (!handOverlayCtx || !handOverlayCanvas) return;
    
    clearHandOverlay();
    
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        return;
    }
    
    const width = handOverlayCanvas.width;
    const height = handOverlayCanvas.height;
    
    // Draw each hand with different colors
    const handColors = [
        'rgba(0, 200, 255, 0.9)',  // Cyan for first hand
        'rgba(255, 200, 0, 0.9)'   // Yellow for second hand
    ];
    
    results.multiHandLandmarks.forEach((landmarks, handIndex) => {
        if (handIndex >= 2) return; // Only draw up to 2 hands
        
        const color = handColors[handIndex] || handColors[0];
        const handedness = (results.multiHandedness && results.multiHandedness[handIndex] && results.multiHandedness[handIndex].label) || null;
        
        // Extract hand info for pinch visualization
        const handInfo = extractHandInfo(landmarks, handedness);
        
        // Draw connections
        handOverlayCtx.lineCap = 'round';
        handOverlayCtx.lineJoin = 'round';
        handOverlayCtx.strokeStyle = color;
        handOverlayCtx.lineWidth = Math.max(2, Math.min(width, height) * 0.006);
        
        HAND_CONNECTIONS.forEach(([a, b]) => {
            const pa = landmarks[a];
            const pb = landmarks[b];
            if (!pa || !pb) return;
            const ax = pa.x * width;
            const ay = pa.y * height;
            const bx = pb.x * width;
            const by = pb.y * height;
            handOverlayCtx.beginPath();
            handOverlayCtx.moveTo(ax, ay);
            handOverlayCtx.lineTo(bx, by);
            handOverlayCtx.stroke();
        });
        
        // Draw joints
        handOverlayCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        const r = Math.max(2, Math.min(width, height) * 0.004);
        landmarks.forEach((p) => {
            const x = p.x * width;
            const y = p.y * height;
            handOverlayCtx.beginPath();
            handOverlayCtx.arc(x, y, r, 0, Math.PI * 2);
            handOverlayCtx.fill();
        });
        
        // Draw pinch indicator if pinching
        if (handInfo.is_pinching) {
            const pinchX = handInfo.pinch_center.x * width;
            const pinchY = handInfo.pinch_center.y * height;
            
            // Draw pinch circle
            handOverlayCtx.strokeStyle = 'rgba(255, 100, 100, 0.8)';
            handOverlayCtx.lineWidth = 3;
            handOverlayCtx.beginPath();
            handOverlayCtx.arc(pinchX, pinchY, 15, 0, Math.PI * 2);
            handOverlayCtx.stroke();
            
            // Draw pinch center dot
            handOverlayCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
            handOverlayCtx.beginPath();
            handOverlayCtx.arc(pinchX, pinchY, 5, 0, Math.PI * 2);
            handOverlayCtx.fill();
        }
        
        // Draw palm center
        const palmX = handInfo.palm_center.x * width;
        const palmY = handInfo.palm_center.y * height;
        handOverlayCtx.fillStyle = 'rgba(100, 255, 100, 0.7)';
        handOverlayCtx.beginPath();
        handOverlayCtx.arc(palmX, palmY, 8, 0, Math.PI * 2);
        handOverlayCtx.fill();
        
        // Draw gesture label
        if (handInfo.gestures && handInfo.gestures.length > 0) {
            const gestureText = handInfo.gestures[0].toUpperCase();
            handOverlayCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            handOverlayCtx.font = '14px Arial';
            handOverlayCtx.fillText(gestureText, palmX + 15, palmY - 10);
        }
    });
}

// Resize hand overlay when video resizes
remoteVideo.addEventListener('loadedmetadata', () => {
    ensureHandOverlayCanvas();
});
window.addEventListener('resize', () => {
    ensureHandOverlayCanvas();
});

// Build Hand Guidance UI when page is ready
window.addEventListener('DOMContentLoaded', () => {
    createHandGuidanceUI();
});

