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
}

// Start streaming
async function startStreaming() {
    userName = userNameInput.value.trim();
    roomId = roomIdInput.value.trim();

    if (!userName || !roomId) {
        alert('Please enter your name and room ID');
        return;
    }

    // Feature flag: use AR feed streamed from Python instead of local camera
    const USE_AR_FEED = true;

    if (USE_AR_FEED) {
        // Initialize socket and join room without touching camera
        initializeSocket();
        socket.emit('join-room', {
            roomId,
            role: 'clinician',
            userName
        });
        // Prepare UI
        setupPanel.style.display = 'none';
        videoContainer.style.display = 'block';
        currentRoomId.textContent = roomId;
        localVideo.style.display = 'block';
        const vs = document.getElementById('videoStatus');
            if (vs) {
                vs.style.display = 'flex';
                vs.innerHTML = `
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                        <path d="M22 9L17 12L22 15V9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                    </svg>
                    <p>Waiting for AR feed</p>
                `;
            }
        streamStatus.textContent = 'Connecting';
        streamStatus.className = 'status-badge status-connecting';
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
    if (localVideo) {
        localVideo.srcObject = null;
        localVideo.style.display = 'none';
    }
}

// Toggle video
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        videoTrack.enabled = !videoTrack.enabled;
        const textSpan = toggleVideoBtn.querySelector('span');
        if (textSpan) {
            textSpan.textContent = videoTrack.enabled ? 'Video On' : 'Video Off';
        }
    }
}

// Toggle audio
function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        const textSpan = toggleAudioBtn.querySelector('span');
        if (textSpan) {
            textSpan.textContent = audioTrack.enabled ? 'Audio On' : 'Audio Off';
        }
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
    } else {
        // No local camera: request a recvonly video track for AR WebRTC feed
        try {
            pc.addTransceiver('video', { direction: 'recvonly' });
        } catch (e) {
            console.warn('Failed to add recvonly transceiver:', e);
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

    // Receive remote AR video track (from Python)
    pc.ontrack = (event) => {
        try {
            const [remoteStream] = event.streams;
            if (remoteStream) {
                localVideo.srcObject = remoteStream;
                localVideo.style.display = 'block';
                const vs = document.getElementById('videoStatus');
                if (vs) vs.style.display = 'none';
                streamStatus.textContent = 'Connected';
                streamStatus.className = 'status-badge status-connected';
            }
        } catch (e) {
            console.warn('ontrack handler error:', e);
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
        expertsList.innerHTML = '<p class="empty-state">Waiting for experts to join...</p>';
    } else {
        expertsList.innerHTML = '';
        peerConnections.forEach((pc, expertId) => {
            const expertItem = document.createElement('div');
            expertItem.className = 'expert-item';
            const initial = expertId.substring(0, 1).toUpperCase();
            const statusText = pc.connectionState === 'connected' ? 'Connected' : 'Connecting...';
            expertItem.innerHTML = `
                <div class="expert-avatar">${initial}</div>
                <div class="expert-info">
                    <div class="expert-name">Expert ${expertId.substring(0, 8)}</div>
                    <div class="expert-status">${statusText}</div>
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
        annotationElement.innerHTML = `<div class="annotation-arrow"></div>`;
    } else if (annotation.type === 'text') {
        annotationElement.innerHTML = `<div class="annotation-text">${escapeHtml(annotation.text)}</div>`;
    }

    annotationsOverlay.appendChild(annotationElement);

    // Remove annotation after 5 seconds
    setTimeout(() => {
        annotationElement.remove();
    }, 5000);
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

// Handle clear annotations
function handleClearAnnotations() {
    annotationsOverlay.innerHTML = '';
}

// Removed JS hand skeleton overlay; rely on MediaPipe-driven guidance instead.

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

