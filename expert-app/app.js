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

