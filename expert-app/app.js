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
    serverInfo.style.cssText = 'position: fixed; bottom: 16px; left: 16px; background: rgba(0,0,0,0.8); backdrop-filter: blur(10px); color: white; padding: 12px 16px; border-radius: 10px; font-size: 12px; z-index: 1000; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;';
    
    const isAutoDetected = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    
    if (isAutoDetected) {
        serverInfo.innerHTML = `<strong>Server:</strong> ${SIGNALING_SERVER} <span style="opacity: 0.7;">(auto-detected)</span>`;
    } else {
        serverInfo.innerHTML = `<strong>Server:</strong> ${SIGNALING_SERVER}<br><button onclick="changeServer()" style="margin-top: 8px; padding: 6px 12px; cursor: pointer; background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3); color: white; border-radius: 6px; font-size: 12px;">Change Server</button>`;
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
let currentPeerId = null;

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
const HAND_SKELETON_FPS = 30; // throttle to ~30 fps

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


    setupPanel.style.display = 'none';
    consultationContainer.style.display = 'block';
    currentRoomId.textContent = roomId;

    console.log('Joined session');

    enableHandGuidance().catch(() => {});
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
            const textSpan = toggleAudioBtn.querySelector('span');
            if (textSpan) {
                textSpan.textContent = audioTrack.enabled ? 'Audio On' : 'Audio Off';
            }
        }
    }
}

// Handle user joined
async function handleUserJoined({ userId, role, userName }) {
    console.log(`User joined: ${userName} (${role})`);
    try {
        // If AR Python (expert sender) joins, initiate a recvonly WebRTC to receive its video
        const isArPython = userName && userName.toLowerCase().includes('ar python');
        if (role === 'expert' && isArPython) {
            peerConnection = createPeerConnection();
            currentPeerId = userId;
            try {
                peerConnection.addTransceiver('video', { direction: 'recvonly' });
            } catch (e) {
                console.warn('Failed to add recvonly transceiver:', e);
            }
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', {
                offer,
                targetId: userId
            });
        }
    } catch (e) {
        console.warn('Failed to connect to AR sender:', e);
    }
    updateUsersList();
}

// Handle user left
function handleUserLeft({ userId, role, userName }) {
    console.log(`User left: ${userName} (${role})`);
    
    if (role === 'clinician') {
        videoStatus.style.display = 'flex';
        videoStatus.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                <path d="M22 9L17 12L22 15V9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            </svg>
            <p>Clinician disconnected</p>
        `;
        streamStatus.textContent = 'Disconnected';
        streamStatus.className = 'status-badge status-disconnected';
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
        streamStatus.className = 'status-badge status-connected';
        
        // Resize canvas to match video
        resizeCanvas();
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: currentPeerId || null
            });
        }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
            streamStatus.textContent = 'Connected';
            streamStatus.className = 'status-badge status-connected';
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            streamStatus.textContent = 'Disconnected';
            streamStatus.className = 'status-badge status-disconnected';
            videoStatus.style.display = 'flex';
            videoStatus.innerHTML = `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                    <path d="M22 9L17 12L22 15V9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                </svg>
                <p>Connection lost</p>
            `;
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
            <div class="user-avatar">C</div>
            <div class="user-info">
                <div class="user-name">Clinician</div>
                <div class="user-status">Online</div>
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
        annotationDiv.innerHTML = '<div class="annotation-arrow"></div>';
    } else if (annotation.type === 'text') {
        annotationDiv.innerHTML = `<div class="annotation-text-display">${escapeHtml(annotation.text)}</div>`;
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

// Helper function to escape HTML
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Resize canvas when video loads
remoteVideo.addEventListener('loadedmetadata', resizeCanvas);
window.addEventListener('resize', resizeCanvas);

// -----------------------------
// Hand Guidance (MediaPipe Hands)
// -----------------------------

function createHandGuidanceUI() {
    const ui = document.createElement('div');
    ui.style.cssText = 'position: fixed; bottom: 16px; right: 16px; background: rgba(0,0,0,0.8); backdrop-filter: blur(10px); color: white; padding: 12px 16px; border-radius: 10px; font-size: 12px; z-index: 1000; display: flex; gap: 12px; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;';
    ui.id = 'handGuidancePanel';
    const label = document.createElement('span');
    label.textContent = 'Hand Guidance';
    label.style.fontWeight = '500';
    ui.appendChild(label);
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
    // Notify clinician to clear overlay
    if (socket && roomId) {
        socket.emit('hand-skeleton', { roomId, skeleton: { clear: true, ts: Date.now() } });
    }
}

function onHandsResults(results) {
    // Throttle send rate
    const now = Date.now();
    if (now - lastSkeletonSentAt < (1000 / HAND_SKELETON_FPS)) {
        return;
    }

    const round3 = (v) => Math.round(v * 1000) / 1000;

    let skeletons = [];
    if (results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const handsCount = results.multiHandLandmarks.length;
        for (let i = 0; i < handsCount; i++) {
            const landmarks = results.multiHandLandmarks[i] || [];
            const handedness = (results.multiHandedness && results.multiHandedness[i] && results.multiHandedness[i].label) || null;
            skeletons.push({
                landmarks: landmarks.map(p => ({ x: round3(p.x), y: round3(p.y), z: round3(p.z) })),
                handedness,
                ts: now
            });
        }
    }

    // Backward compatibility: also include a single skeleton field
    const singleSkeleton = skeletons[0] || { clear: true, ts: now };

    if (socket && roomId) {
        socket.emit('hand-skeleton', { roomId, skeletons, skeleton: singleSkeleton });
        lastSkeletonSentAt = now;
    }
}

// Build Hand Guidance UI when page is ready
window.addEventListener('DOMContentLoaded', () => {
    createHandGuidanceUI();
});

