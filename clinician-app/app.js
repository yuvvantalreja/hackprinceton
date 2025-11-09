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
let localStream = null;
let peerConnections = new Map(); // Map of expert ID to RTCPeerConnection
let roomId = null;
let userName = null;

// DOM Elements
const setupPanel = document.getElementById('setupPanel');
const videoContainer = document.getElementById('videoContainer');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const localVideo = document.getElementById('localVideo');
const userNameInput = document.getElementById('userName');
const roomIdInput = document.getElementById('roomId');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const expertsList = document.getElementById('expertsList');
const currentRoomId = document.getElementById('currentRoomId');
const annotationsOverlay = document.getElementById('annotationsOverlay');

// Event Listeners
startBtn.addEventListener('click', startStreaming);
stopBtn.addEventListener('click', stopStreaming);
toggleVideoBtn.addEventListener('click', toggleVideo);
toggleAudioBtn.addEventListener('click', toggleAudio);

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
    socket.on('annotation', handleAnnotation);
    socket.on('clear-annotations', handleClearAnnotations);
    socket.on('room-users', handleRoomUsers);
    socket.on('hand-skeleton', handleHandSkeleton);
    socket.on('cad-state', handleCadState);
}

// Start streaming
async function startStreaming() {
    userName = userNameInput.value.trim();
    roomId = roomIdInput.value.trim();

    if (!userName || !roomId) {
        alert('Please enter your name and room ID');
        return;
    }

    // Check if mediaDevices is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const errorMsg = 'Your browser does not support camera/microphone access. Please use a modern browser like Chrome, Firefox, Safari, or Edge.';
        alert(errorMsg);
        console.error('MediaDevices API not available');
        return;
    }

    try {
        // Check available devices first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const audioDevices = devices.filter(device => device.kind === 'audioinput');
        
        console.log('Available video devices:', videoDevices.length);
        console.log('Available audio devices:', audioDevices.length);

        if (videoDevices.length === 0) {
            alert('No camera found. Please connect a camera and refresh the page.');
            return;
        }

        // Try with ideal constraints first, fallback to simpler constraints
        let constraints = {
            video: {
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 30, max: 60 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };

        try {
            // Try with ideal constraints
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Got stream with ideal constraints');
        } catch (error) {
            console.warn('Ideal constraints failed, trying simpler constraints:', error);
            // Fallback to simpler constraints
            constraints = {
                video: true,
                audio: true
            };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Got stream with basic constraints');
        }

        // Verify stream has tracks
        const videoTracks = localStream.getVideoTracks();
        const audioTracks = localStream.getAudioTracks();
        
        console.log('Video tracks:', videoTracks.length);
        console.log('Audio tracks:', audioTracks.length);
        
        if (videoTracks.length === 0) {
            throw new Error('No video track available');
        }
        
        // Improve encoder behavior for camera motion and target 30-60fps
        try {
            const primaryVideoTrack = videoTracks[0];
            if (primaryVideoTrack) {
                try {
                    primaryVideoTrack.contentHint = 'motion';
                } catch (e) {
                    console.warn('contentHint not supported:', e);
                }
                try {
                    await primaryVideoTrack.applyConstraints({ frameRate: { ideal: 30, max: 60 } });
                } catch (e) {
                    console.warn('applyConstraints failed:', e);
                }
            }
        } catch (e) {
            console.warn('Failed to optimize video track:', e);
        }

        // Set video source
        localVideo.srcObject = localStream;

        // Wait for video to be ready
        await new Promise((resolve) => {
            localVideo.onloadedmetadata = () => {
                console.log('Video metadata loaded:', localVideo.videoWidth, 'x', localVideo.videoHeight);
                resolve();
            };
        });

        // Initialize socket connection
        initializeSocket();

        // Join room
        socket.emit('join-room', {
            roomId,
            role: 'clinician',
            userName
        });

        // Update UI
        setupPanel.style.display = 'none';
        videoContainer.style.display = 'block';
        currentRoomId.textContent = roomId;

        console.log('Started streaming successfully');
    } catch (error) {
        console.error('Error accessing media devices:', error);
        
        let errorMessage = 'Failed to access camera/microphone.\n\n';
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMessage += 'Permission denied. Please:\n';
            errorMessage += '1. Click the lock/camera icon in the address bar\n';
            errorMessage += '2. Allow camera and microphone access\n';
            errorMessage += '3. Refresh the page and try again';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            errorMessage += 'No camera or microphone found.\n';
            errorMessage += 'Please ensure your camera and microphone are connected and not being used by another application.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            errorMessage += 'Camera/microphone is already in use.\n';
            errorMessage += 'Please close other applications using the camera (Zoom, Teams, etc.) and try again.';
        } else if (error.name === 'OverconstrainedError' || error.name === 'ConstraintNotSatisfiedError') {
            errorMessage += 'Camera does not support the requested settings.\n';
            errorMessage += 'Trying with default settings...';
            // Try again with basic constraints
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                localVideo.srcObject = localStream;
                initializeSocket();
                socket.emit('join-room', { roomId, role: 'clinician', userName });
                setupPanel.style.display = 'none';
                videoContainer.style.display = 'block';
                currentRoomId.textContent = roomId;
                console.log('Started streaming with fallback constraints');
                return;
            } catch (fallbackError) {
                errorMessage += '\n\nFallback also failed. Please check your camera settings.';
            }
        } else if (error.name === 'TypeError') {
            errorMessage += 'Browser does not support camera access.\n';
            errorMessage += 'Please use HTTPS or localhost.';
        } else {
            errorMessage += `Error: ${error.name}\n`;
            errorMessage += `Message: ${error.message}\n\n`;
            errorMessage += 'Please check:\n';
            errorMessage += '1. Camera/microphone permissions\n';
            errorMessage += '2. No other apps using the camera\n';
            errorMessage += '3. Browser supports WebRTC (Chrome, Firefox, Safari, Edge)';
        }
        
        alert(errorMessage);
    }
}

// Stop streaming
function stopStreaming() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();

    if (socket) {
        socket.disconnect();
        socket = null;
    }

    setupPanel.style.display = 'block';
    videoContainer.style.display = 'none';
    updateConnectionStatus(false);
}

// Toggle video
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        videoTrack.enabled = !videoTrack.enabled;
        toggleVideoBtn.textContent = videoTrack.enabled ? '📹 Video On' : '📹 Video Off';
    }
}

// Toggle audio
function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        toggleAudioBtn.textContent = audioTrack.enabled ? '🎤 Audio On' : '🎤 Audio Off';
    }
}

// Handle new user joining
async function handleUserJoined({ userId, role, userName }) {
    console.log(`User joined: ${userName} (${role})`);
    
    if (role === 'expert') {
        // Create peer connection for the expert
        const pc = createPeerConnection(userId);
        
        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.emit('offer', {
            offer,
            targetId: userId
        });
        
        updateExpertsList();
    }
}

// Handle user leaving
function handleUserLeft({ userId, role, userName }) {
    console.log(`User left: ${userName} (${role})`);
    
    if (peerConnections.has(userId)) {
        peerConnections.get(userId).close();
        peerConnections.delete(userId);
        updateExpertsList();
    }
}

// Handle offer from expert (in case expert initiates)
async function handleOffer({ offer, senderId }) {
    console.log('Received offer from:', senderId);
    
    const pc = createPeerConnection(senderId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('answer', {
        answer,
        targetId: senderId
    });
}

// Handle answer from expert
async function handleAnswer({ answer, senderId }) {
    console.log('Received answer from:', senderId);
    
    const pc = peerConnections.get(senderId);
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
}

// Handle ICE candidate
async function handleIceCandidate({ candidate, senderId }) {
    const pc = peerConnections.get(senderId);
    if (pc && candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

// Create peer connection
function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Add local stream tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, localStream);
            if (track.kind === 'video') {
                try {
                    const parameters = sender.getParameters();
                    if (!parameters.encodings || parameters.encodings.length === 0) {
                        parameters.encodings = [{}];
                    }
                    // Target higher quality; browsers may cap based on network conditions
                    parameters.encodings[0].maxBitrate = 2500000; // ~2.5 Mbps
                    parameters.encodings[0].maxFramerate = 30;
                    parameters.encodings[0].scaleResolutionDownBy = 1.0;
                    sender.setParameters(parameters).catch(e => console.warn('setParameters failed:', e));
                } catch (e) {
                    console.warn('Unable to set sender parameters:', e);
                }
            }
        });
        // Prefer H264 for broad compatibility and good quality
        try {
            const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
            transceivers.forEach((t) => {
                if (!t.sender || !t.sender.track || t.sender.track.kind !== 'video') return;
                const caps = (RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video')) ||
                             (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video'));
                if (!caps || !t.setCodecPreferences) return;
                const codecs = caps.codecs.filter(c => c.mimeType.toLowerCase().startsWith('video/'));
                // Reorder to prefer H264 first if available
                const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
                const others = codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
                const reordered = h264.length ? [...h264, ...others] : codecs;
                t.setCodecPreferences(reordered);
            });
        } catch (e) {
            console.warn('Codec preference not set:', e);
        }
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: peerId
            });
        }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerId}:`, pc.connectionState);
    };

    peerConnections.set(peerId, pc);
    return pc;
}

// Handle room users (initial state)
function handleRoomUsers(users) {
    console.log('Room users:', users);
    updateExpertsList();
}

// Update experts list in UI
function updateExpertsList() {
    const expertCount = peerConnections.size;
    
    if (expertCount === 0) {
        expertsList.innerHTML = '<p class="no-experts">Waiting for experts to join...</p>';
    } else {
        expertsList.innerHTML = '';
        peerConnections.forEach((pc, expertId) => {
            const expertItem = document.createElement('div');
            expertItem.className = 'expert-item';
            expertItem.innerHTML = `
                <span class="icon">👨‍⚕️</span>
                <div>
                    <strong>Expert ${expertId.substring(0, 8)}</strong>
                    <div style="font-size: 12px; color: #666;">
                        ${pc.connectionState === 'connected' ? '✅ Connected' : '🔄 Connecting...'}
                    </div>
                </div>
            `;
            expertsList.appendChild(expertItem);
        });
    }
}

// Handle annotations from experts
function handleAnnotation({ annotation, senderId }) {
    console.log('Received annotation:', annotation);
    displayAnnotation(annotation);
}

// Display annotation on overlay
function displayAnnotation(annotation) {
    const annotationElement = document.createElement('div');
    annotationElement.className = 'annotation';
    annotationElement.style.left = annotation.x + '%';
    annotationElement.style.top = annotation.y + '%';

    if (annotation.type === 'arrow') {
        annotationElement.innerHTML = `<div class="annotation-arrow">👇</div>`;
    } else if (annotation.type === 'text') {
        annotationElement.innerHTML = `<div class="annotation-text">${annotation.text}</div>`;
    }

    annotationsOverlay.appendChild(annotationElement);

    // Remove annotation after 5 seconds
    setTimeout(() => {
        annotationElement.remove();
    }, 5000);
}

// Handle clear annotations
function handleClearAnnotations() {
    annotationsOverlay.innerHTML = '';
}

// -----------------------------
// Hand Skeleton Overlay
// -----------------------------
let handCanvas = null;
let handCtx = null;
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

function ensureHandCanvas() {
    if (!handCanvas) {
        handCanvas = document.createElement('canvas');
        handCanvas.id = 'handOverlay';
        handCanvas.style.position = 'absolute';
        handCanvas.style.left = '0';
        handCanvas.style.top = '0';
        handCanvas.style.width = '100%';
        handCanvas.style.height = '100%';
        handCanvas.style.pointerEvents = 'none';
        annotationsOverlay.appendChild(handCanvas);
        handCtx = handCanvas.getContext('2d');
    }
    // Match canvas pixel size to overlay box
    const rect = annotationsOverlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (handCanvas.width !== w || handCanvas.height !== h) {
        handCanvas.width = w;
        handCanvas.height = h;
    }
}

function clearHandOverlay() {
    if (!handCtx) return;
    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
}

function drawHandSkeleton(landmarks) {
    ensureHandCanvas();
    if (!handCtx) return;
    clearHandOverlay();

    const dpr = window.devicePixelRatio || 1;
    const rect = annotationsOverlay.getBoundingClientRect();
    const width = handCanvas.width;
    const height = handCanvas.height;

    // Draw connections
    handCtx.lineCap = 'round';
    handCtx.lineJoin = 'round';
    handCtx.strokeStyle = 'rgba(0, 200, 255, 0.9)';
    handCtx.lineWidth = Math.max(2, Math.min(width, height) * 0.006);

    HAND_CONNECTIONS.forEach(([a, b]) => {
        const pa = landmarks[a];
        const pb = landmarks[b];
        if (!pa || !pb) return;
        const ax = pa.x * width;
        const ay = pa.y * height;
        const bx = pb.x * width;
        const by = pb.y * height;
        handCtx.beginPath();
        handCtx.moveTo(ax, ay);
        handCtx.lineTo(bx, by);
        handCtx.stroke();
    });

    // Draw joints
    handCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    const r = Math.max(2, Math.min(width, height) * 0.004);
    landmarks.forEach((p) => {
        const x = p.x * width;
        const y = p.y * height;
        handCtx.beginPath();
        handCtx.arc(x, y, r, 0, Math.PI * 2);
        handCtx.fill();
    });
}

function drawMultipleHands(hands) {
    ensureHandCanvas();
    if (!handCtx) return;
    clearHandOverlay();

    const dpr = window.devicePixelRatio || 1;
    const rect = annotationsOverlay.getBoundingClientRect();
    const width = handCanvas.width;
    const height = handCanvas.height;

    // Colors for different hands (for visual distinction)
    const handColors = [
        'rgba(0, 200, 255, 0.9)',   // Cyan for first hand
        'rgba(255, 100, 150, 0.9)'  // Pink for second hand
    ];

    // Draw each hand
    hands.forEach((hand, handIdx) => {
        const landmarks = hand.landmarks || [];
        if (!landmarks.length) return;

        const color = handColors[handIdx % handColors.length];

        // Draw connections
        handCtx.lineCap = 'round';
        handCtx.lineJoin = 'round';
        handCtx.strokeStyle = color;
        handCtx.lineWidth = Math.max(2, Math.min(width, height) * 0.006);

        HAND_CONNECTIONS.forEach(([a, b]) => {
            const pa = landmarks[a];
            const pb = landmarks[b];
            if (!pa || !pb) return;
            const ax = pa.x * width;
            const ay = pa.y * height;
            const bx = pb.x * width;
            const by = pb.y * height;
            handCtx.beginPath();
            handCtx.moveTo(ax, ay);
            handCtx.lineTo(bx, by);
            handCtx.stroke();
        });

        // Draw joints
        handCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        const r = Math.max(2, Math.min(width, height) * 0.004);
        landmarks.forEach((p) => {
            const x = p.x * width;
            const y = p.y * height;
            handCtx.beginPath();
            handCtx.arc(x, y, r, 0, Math.PI * 2);
            handCtx.fill();
        });

        // Draw hand label (Left/Right)
        if (hand.handedness) {
            const wrist = landmarks[0]; // Wrist is landmark 0
            if (wrist) {
                const labelX = wrist.x * width;
                const labelY = wrist.y * height - 20;
                handCtx.fillStyle = color;
                handCtx.font = 'bold 16px Arial';
                handCtx.textAlign = 'center';
                handCtx.fillText(hand.handedness, labelX, labelY);
            }
        }
    });
}

function handleHandSkeleton({ skeleton }) {
    if (!skeleton || skeleton.clear) {
        clearHandOverlay();
        return;
    }

    // Support both old format (single hand) and new format (multiple hands)
    if (skeleton.hands && Array.isArray(skeleton.hands)) {
        // New format: multiple hands
        if (skeleton.hands.length === 0) {
            clearHandOverlay();
            return;
        }
        drawMultipleHands(skeleton.hands);
    } else if (skeleton.landmarks) {
        // Old format: single hand (backward compatibility)
        const landmarks = skeleton.landmarks || [];
        if (!landmarks.length) {
            clearHandOverlay();
            return;
        }
        drawHandSkeleton(landmarks);
    } else {
        clearHandOverlay();
    }
}

// Keep overlay in sync with video size
function resizeHandOverlay() {
    if (!annotationsOverlay) return;
    if (!handCanvas) return;
    ensureHandCanvas();
    clearHandOverlay();
}

// Hook into existing lifecycle
window.addEventListener('resize', resizeHandOverlay);
// After video is visible, create overlay
localVideo && localVideo.addEventListener('loadedmetadata', () => {
    setTimeout(() => {
        ensureHandCanvas();
        resizeHandOverlay();
    }, 0);
});

// -----------------------------
// CAD Object 3D Overlay (Three.js)
// -----------------------------
let threeLoaded = false;
let cadRenderer = null;
let cadScene = null;
let cadCamera = null;
let cadMeshes = new Map();
let cadAnimId = null;
let cadLastSeenTick = 0;
let objLoaderReady = false;

function loadThreeScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function ensureThree() {
    if (threeLoaded) return;
    await loadThreeScript('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js');
    threeLoaded = true;
}

function ensureObjLoader() {
    return new Promise(async (resolve, reject) => {
        await ensureThree();
        if (objLoaderReady && THREE.OBJLoader) {
            resolve(true);
            return;
        }
        // Use non-module loader that attaches to global THREE
        loadThreeScript('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/js/loaders/OBJLoader.js')
            .then(() => {
                objLoaderReady = !!THREE.OBJLoader;
                if (objLoaderReady) resolve(true);
                else reject(new Error('OBJLoader failed to attach'));
            })
            .catch(reject);
    });
}

function initCadOverlay() {
    if (!threeLoaded) return;
    if (cadRenderer) return;
    const container = annotationsOverlay;
    cadRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    cadRenderer.setPixelRatio(window.devicePixelRatio || 1);
    cadRenderer.setClearColor(0x000000, 0);
    cadRenderer.domElement.style.position = 'absolute';
    cadRenderer.domElement.style.left = '0';
    cadRenderer.domElement.style.top = '0';
    cadRenderer.domElement.style.width = '100%';
    cadRenderer.domElement.style.height = '100%';
    cadRenderer.domElement.style.pointerEvents = 'none';
    cadRenderer.domElement.style.zIndex = '10';
    container.appendChild(cadRenderer.domElement);

    const rect = container.getBoundingClientRect();
    cadScene = new THREE.Scene();
    cadCamera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.1, 100);
    cadCamera.position.set(0, 0, 5);

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.8);
    cadScene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 7);
    cadScene.add(dir);

    resizeCadOverlay();
    animateCad();
    window.addEventListener('resize', resizeCadOverlay);
}

function resizeCadOverlay() {
    if (!cadRenderer || !cadCamera) return;
    const rect = annotationsOverlay.getBoundingClientRect();
    cadCamera.aspect = Math.max(1e-3, rect.width / Math.max(1, rect.height));
    cadCamera.updateProjectionMatrix();
    cadRenderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
}

function animateCad() {
    if (!cadRenderer || !cadScene || !cadCamera) return;
    cadAnimId = requestAnimationFrame(animateCad);
    cadRenderer.render(cadScene, cadCamera);
}

function resolveModelUrlByName(name) {
    if (!name) return null;
    const n = name.toLowerCase();
    if (n.includes('needle')) return '/assets/Needle.obj';
    if (n.includes('crate') || n.includes('box')) return '/assets/Wooden Crate.obj'; // if present
    if (n.includes('iron') && n.includes('man')) return '/assets/ironman_simple.obj'; // if present
    return null;
}

function makeGeometryForName(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('needle')) {
        return new THREE.CylinderGeometry(0.02, 0.02, 1.2, 16);
    }
    if (n.includes('crate') || n.includes('box')) {
        return new THREE.BoxGeometry(1, 1, 1);
    }
    if (n.includes('forceps') || n.includes('tweezer')) {
        // Two thin boxes grouped
        const group = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0x99bbff, metalness: 0.6, roughness: 0.3 });
        const armGeom = new THREE.BoxGeometry(0.08, 1.2, 0.08);
        const arm1 = new THREE.Mesh(armGeom, mat);
        const arm2 = new THREE.Mesh(armGeom, mat);
        arm1.position.set(-0.05, 0, 0);
        arm2.position.set(0.05, 0, 0);
        group.add(arm1);
        group.add(arm2);
        return group; // special case: group not geometry
    }
    // Default sphere
    return new THREE.SphereGeometry(0.5, 24, 24);
}

async function upsertCadObject(obj) {
    // obj: { id, name, type, position:{x,y,z}, rotation:{x,y,z}, scale, grabbed? }
    if (!cadScene) return;
    let entry = cadMeshes.get(obj.id);
    if (!entry) {
        entry = { mesh: null, loading: false, modelUrl: resolveModelUrlByName(obj.name), normScale: 1 };
        cadMeshes.set(obj.id, entry);
        // Create placeholder immediately
        const placeholderGeom = makeGeometryForName(obj.name);
        const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x66ccff, metalness: 0.2, roughness: 0.7 });
        const placeholderMesh = placeholderGeom instanceof THREE.Group ? placeholderGeom : new THREE.Mesh(placeholderGeom, placeholderMat);
        entry.mesh = placeholderMesh;
        cadScene.add(placeholderMesh);
        // Try to load real OBJ if available
        if (entry.modelUrl && !entry.loading) {
            entry.loading = true;
            try {
                await ensureObjLoader();
                const loader = new THREE.OBJLoader();
                loader.load(
                    entry.modelUrl,
                    (obj3d) => {
                        // Replace placeholder
                        if (entry.mesh) {
                            cadScene.remove(entry.mesh);
                            // dispose placeholder
                            entry.mesh.traverse ? entry.mesh.traverse(n => {
                                if (n.isMesh) {
                                    n.geometry && n.geometry.dispose && n.geometry.dispose();
                                    n.material && n.material.dispose && n.material.dispose();
                                }
                            }) : (() => {
                                entry.mesh.geometry && entry.mesh.geometry.dispose && entry.mesh.geometry.dispose();
                                entry.mesh.material && entry.mesh.material.dispose && entry.mesh.material.dispose();
                            })();
                        }
                        // Standardize materials
                        obj3d.traverse(n => {
                            if (n.isMesh) {
                                n.material = new THREE.MeshStandardMaterial({
                                    color: 0xcccccc,
                                    metalness: 0.3,
                                    roughness: 0.6
                                });
                                n.castShadow = false;
                                n.receiveShadow = false;
                            }
                        });
                        // Normalize size to ~2.0 max dimension to match Python
                        try {
                            const box = new THREE.Box3().setFromObject(obj3d);
                            const size = new THREE.Vector3();
                            box.getSize(size);
                            const maxDim = Math.max(size.x, size.y, size.z) || 1;
                            const target = 2.0;
                            const scaleMul = target / maxDim;
                            obj3d.scale.multiplyScalar(scaleMul);
                            const center = new THREE.Vector3();
                            box.getCenter(center);
                            obj3d.position.sub(center);
                            entry.normScale = scaleMul;
                        } catch (e) {
                            entry.normScale = 1;
                        }
                        entry.mesh = obj3d;
                        cadScene.add(entry.mesh);
                        entry.loading = false;
                    },
                    undefined,
                    () => {
                        entry.loading = false;
                        // keep placeholder
                    }
                );
            } catch (e) {
                entry.loading = false;
            }
        }
    }
    const { mesh } = entry;
    // Apply transform
    if (mesh.isMesh || mesh.isGroup) {
        mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
        mesh.rotation.set(obj.rotation.x || 0, obj.rotation.y || 0, obj.rotation.z || 0);
        const s = obj.scale || 1;
        const ns = entry.normScale || 1;
        mesh.scale.set(ns * s, ns * s, ns * s);
    }
    // Simple grabbed highlight toggle
    const highlight = !!obj.grabbed;
    if (mesh.material) {
        mesh.material.emissive = mesh.material.emissive || new THREE.Color(0x000000);
        mesh.material.emissive.setHex(highlight ? 0x333333 : 0x000000);
    } else {
        mesh.traverse(n => {
            if (n.isMesh) {
                n.material.emissive = n.material.emissive || new THREE.Color(0x000000);
                n.material.emissive.setHex(highlight ? 0x333333 : 0x000000);
            }
        });
    }
    entry._seenTick = cadLastSeenTick;
}

function gcCadMeshes() {
    // Remove meshes not seen in this tick
    const toRemove = [];
    cadMeshes.forEach((entry, id) => {
        if (entry._seenTick !== cadLastSeenTick) {
            toRemove.push(id);
        }
    });
    toRemove.forEach(id => {
        const entry = cadMeshes.get(id);
        if (entry && entry.mesh) {
            cadScene.remove(entry.mesh);
            // dispose
            entry.mesh.traverse ? entry.mesh.traverse(n => {
                if (n.isMesh) {
                    n.geometry && n.geometry.dispose && n.geometry.dispose();
                    n.material && n.material.dispose && n.material.dispose();
                }
            }) : (() => {
                entry.mesh.geometry && entry.mesh.geometry.dispose && entry.mesh.geometry.dispose();
                entry.mesh.material && entry.mesh.material.dispose && entry.mesh.material.dispose();
            })();
        }
        cadMeshes.delete(id);
    });
}

async function handleCadState({ state }) {
    if (!state) return;
    await ensureThree();
    initCadOverlay();
    if (state.clear) {
        // Clear all
        cadMeshes.forEach(entry => {
            if (entry.mesh) cadScene.remove(entry.mesh);
        });
        cadMeshes.clear();
        return;
    }
    cadLastSeenTick++;
    const list = Array.isArray(state.objects) ? state.objects : [];
    list.forEach(obj => {
        // Ensure required fields and defaults
        const id = obj.id != null ? obj.id : obj.name || Math.random().toString(36).slice(2);
        const safe = {
            id,
            name: obj.name || `Object-${id}`,
            type: obj.type || 'cad',
            position: obj.position || { x: 0, y: 0, z: -3 },
            rotation: obj.rotation || { x: 0, y: 0, z: 0 },
            scale: obj.scale || 1,
            grabbed: !!obj.grabbed
        };
        upsertCadObject(safe);
    });
    gcCadMeshes();
}

// Update connection status indicator
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

