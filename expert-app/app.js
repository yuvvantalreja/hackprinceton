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
    socket.on('cad-state', handleCadState);
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
        maxNumHands: 2,  // Support 2 hands now
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
    handControlEnabled = true;  // Enable 3D object controls when hand guidance is enabled

    // Initialize 3D overlay and create a test needle object
    await ensureThree();
    initCadOverlay();

    // Create initial test object (Needle) - use setTimeout to ensure DOM is ready
    setTimeout(async () => {
        const testNeedle = {
            id: 0,
            name: 'Needle',
            type: 'cad',
            position: { x: 0, y: 0, z: -3 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: 1,
            grabbed: false
        };
        await upsertCadObject(testNeedle);
        console.log('Hand controls enabled - you can now pinch and manipulate 3D objects!');
        console.log('Needle object created at:', testNeedle.position);
    }, 100);

    // Enable local hand visualization for expert
    initExpertHandOverlay();
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
    handControlEnabled = false;  // Disable 3D controls too
    currentHandResults = null;

    // Clear grab states
    grabState.singleHandGrab = null;
    grabState.twoHandGrab = null;
    grabState.rotationMode = null;

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

    let payload;
    if (results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        // Support multiple hands - send all detected hands
        const hands = [];
        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            const landmarks = results.multiHandLandmarks[i] || [];
            const handedness = (results.multiHandedness && results.multiHandedness[i] && results.multiHandedness[i].label) || null;
            hands.push({
                landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })),
                handedness,
                handIndex: i
            });
        }
        payload = {
            hands,
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
}

// Build Hand Guidance UI when page is ready
window.addEventListener('DOMContentLoaded', () => {
    createHandGuidanceUI();
});

// -----------------------------
// 3D CAD Object Overlay with Hand Controls (Three.js)
// -----------------------------

let threeLoaded = false;
let cadRenderer = null;
let cadScene = null;
let cadCamera = null;
let cadMeshes = new Map();
let cadAnimId = null;
let cadLastSeenTick = 0;
let objLoaderReady = false;
let cadContainer = null;

// Hand control state for 3D objects
let handControlEnabled = false;
let currentHandResults = null;
let grabbedObject = null;
let grabState = {
    singleHandGrab: null,    // {objectId, handIndex, initialDistance}
    twoHandGrab: null,       // {objectId, handIndices: [0,1], initialDistance, initialScale}
    rotationMode: null       // {objectId, handIndex, lastPos}
};

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
    if (!threeLoaded) {
        console.error('THREE.js not loaded yet!');
        return;
    }
    if (cadRenderer) {
        console.log('CAD overlay already initialized');
        return;
    }

    // Use the video wrapper as container
    const videoWrapper = document.querySelector('.video-wrapper');
    if (!videoWrapper) {
        console.error('Video wrapper not found!');
        return;
    }

    console.log('Initializing CAD overlay...');

    cadContainer = document.createElement('div');
    cadContainer.style.cssText = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 15;';
    cadContainer.id = 'cadContainer';
    videoWrapper.appendChild(cadContainer);

    cadRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    cadRenderer.setPixelRatio(window.devicePixelRatio || 1);
    cadRenderer.setClearColor(0x000000, 0);
    cadRenderer.domElement.style.cssText = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none;';
    cadContainer.appendChild(cadRenderer.domElement);

    const rect = videoWrapper.getBoundingClientRect();
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

    console.log('3D CAD overlay initialized successfully');
    console.log('Canvas size:', cadRenderer.domElement.width, 'x', cadRenderer.domElement.height);
    console.log('Scene children:', cadScene.children.length);
}

function resizeCadOverlay() {
    if (!cadRenderer || !cadCamera || !cadContainer) return;
    const videoWrapper = document.querySelector('.video-wrapper');
    if (!videoWrapper) return;
    const rect = videoWrapper.getBoundingClientRect();
    cadCamera.aspect = Math.max(1e-3, rect.width / Math.max(1, rect.height));
    cadCamera.updateProjectionMatrix();
    cadRenderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
}

function animateCad() {
    if (!cadRenderer || !cadScene || !cadCamera) return;
    cadAnimId = requestAnimationFrame(animateCad);

    // Process hand controls if enabled
    if (handControlEnabled && currentHandResults) {
        processHandControls(currentHandResults);
    }

    cadRenderer.render(cadScene, cadCamera);
}

function resolveModelUrlByName(name) {
    if (!name) return null;
    const n = name.toLowerCase();
    if (n.includes('needle')) return '/assets/Needle.obj';
    if (n.includes('crate') || n.includes('box')) return '/assets/Wooden Crate.obj';
    if (n.includes('iron') && n.includes('man')) return '/assets/ironman_simple.obj';
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
    return new THREE.SphereGeometry(0.5, 24, 24);
}

async function upsertCadObject(obj) {
    if (!cadScene) {
        console.error('CAD scene not initialized!');
        return;
    }

    console.log('Upserting CAD object:', obj);

    let entry = cadMeshes.get(obj.id);
    if (!entry) {
        console.log('Creating new entry for object ID:', obj.id);
        entry = { mesh: null, loading: false, modelUrl: resolveModelUrlByName(obj.name), normScale: 1, metadata: {} };
        cadMeshes.set(obj.id, entry);

        // Create placeholder
        const placeholderGeom = makeGeometryForName(obj.name);
        const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x66ccff, metalness: 0.2, roughness: 0.7 });
        const placeholderMesh = placeholderGeom instanceof THREE.Group ? placeholderGeom : new THREE.Mesh(placeholderGeom, placeholderMat);
        entry.mesh = placeholderMesh;
        cadScene.add(placeholderMesh);
        console.log('Placeholder mesh added to scene. Total objects in scene:', cadScene.children.length);

        // Try to load real OBJ
        if (entry.modelUrl && !entry.loading) {
            entry.loading = true;
            try {
                await ensureObjLoader();
                const loader = new THREE.OBJLoader();
                loader.load(
                    entry.modelUrl,
                    (obj3d) => {
                        if (entry.mesh) {
                            cadScene.remove(entry.mesh);
                        }
                        obj3d.traverse(n => {
                            if (n.isMesh) {
                                n.material = new THREE.MeshStandardMaterial({
                                    color: 0xcccccc,
                                    metalness: 0.3,
                                    roughness: 0.6
                                });
                            }
                        });
                        // Normalize size
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
                    () => { entry.loading = false; }
                );
            } catch (e) {
                entry.loading = false;
            }
        }
    }

    const { mesh } = entry;
    if (mesh.isMesh || mesh.isGroup) {
        mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
        mesh.rotation.set(obj.rotation.x || 0, obj.rotation.y || 0, obj.rotation.z || 0);
        const s = obj.scale || 1;
        const ns = entry.normScale || 1;
        mesh.scale.set(ns * s, ns * s, ns * s);
    }

    // Highlight if grabbed
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

    // Store metadata for hand controls
    entry.metadata = {
        id: obj.id,
        name: obj.name,
        position: obj.position,
        rotation: obj.rotation,
        scale: obj.scale,
        grabbed: obj.grabbed
    };

    entry._seenTick = cadLastSeenTick;
}

function gcCadMeshes() {
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
        }
        cadMeshes.delete(id);
    });
}

async function handleCadState({ state }) {
    if (!state) return;
    await ensureThree();
    initCadOverlay();
    if (state.clear) {
        cadMeshes.forEach(entry => {
            if (entry.mesh) cadScene.remove(entry.mesh);
        });
        cadMeshes.clear();
        return;
    }
    cadLastSeenTick++;
    const list = Array.isArray(state.objects) ? state.objects : [];
    list.forEach(obj => {
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

// -----------------------------
// Hand Controls for 3D Objects (Jarvis-style)
// -----------------------------

function detectPinch(hand) {
    if (!hand || !hand.landmarks || hand.landmarks.length < 21) return null;

    const landmarks = hand.landmarks;
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];

    // Calculate pinch distance
    const dx = (thumbTip.x - indexTip.x);
    const dy = (thumbTip.y - indexTip.y);
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Pinch detected if distance is small (normalized coordinates, so ~0.05 is close)
    const isPinching = distance < 0.08;

    // Calculate pinch center
    const pinchCenter = {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
        z: (thumbTip.z + indexTip.z) / 2
    };

    return {
        isPinching,
        distance,
        pinchCenter,
        thumbTip,
        indexTip
    };
}

function screenToWorld(screenX, screenY, depth = -3) {
    if (!cadCamera || !cadRenderer) return { x: 0, y: 0, z: depth };

    // Convert screen coordinates (0-1) to NDC (-1 to 1)
    const ndcX = screenX * 2 - 1;
    const ndcY = -(screenY * 2 - 1); // Flip Y

    // Simple projection - map to world space at given depth
    const vector = new THREE.Vector3(ndcX, ndcY, 0.5);
    vector.unproject(cadCamera);
    const dir = vector.sub(cadCamera.position).normalize();
    const distance = (depth - cadCamera.position.z) / dir.z;
    const pos = cadCamera.position.clone().add(dir.multiplyScalar(distance));

    return { x: pos.x, y: pos.y, z: depth };
}

function findObjectAtPoint(screenX, screenY) {
    let closestObj = null;
    let closestDist = Infinity;

    cadMeshes.forEach((entry, id) => {
        if (!entry.mesh || !entry.metadata) return;

        const pos = entry.metadata.position;
        const scale = entry.metadata.scale || 1;

        // Project 3D position to screen
        const worldPos = new THREE.Vector3(pos.x, pos.y, pos.z);
        const projected = worldPos.project(cadCamera);

        // Convert to normalized screen coords (0-1)
        const screenPosX = (projected.x + 1) / 2;
        const screenPosY = (-projected.y + 1) / 2;

        // Calculate distance
        const dx = screenPosX - screenX;
        const dy = screenPosY - screenY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Hit radius based on scale
        const hitRadius = 0.1 * scale;

        if (dist < hitRadius && dist < closestDist) {
            closestDist = dist;
            closestObj = { id, entry, distance: dist };
        }
    });

    return closestObj;
}

function processHandControls(results) {
    if (!results || !results.multiHandLandmarks) return;

    const hands = [];
    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
        const landmarks = results.multiHandLandmarks[i] || [];
        const handedness = (results.multiHandedness && results.multiHandedness[i] && results.multiHandedness[i].label) || null;
        hands.push({
            landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })),
            handedness,
            handIndex: i
        });
    }

    // Detect pinches for each hand
    const handPinches = hands.map(hand => detectPinch(hand));

    // Check for two-hand grab (both hands pinching same object)
    const pinchingHands = handPinches.filter(p => p && p.isPinching);

    if (pinchingHands.length === 2 && !grabState.twoHandGrab) {
        // Check if both hands are grabbing the same object
        const obj1 = findObjectAtPoint(pinchingHands[0].pinchCenter.x, pinchingHands[0].pinchCenter.y);
        const obj2 = findObjectAtPoint(pinchingHands[1].pinchCenter.x, pinchingHands[1].pinchCenter.y);

        if (obj1 && obj2 && obj1.id === obj2.id) {
            // Start two-hand grab for scaling
            const dx = pinchingHands[1].pinchCenter.x - pinchingHands[0].pinchCenter.x;
            const dy = pinchingHands[1].pinchCenter.y - pinchingHands[0].pinchCenter.y;
            const initialDist = Math.sqrt(dx * dx + dy * dy);

            grabState.twoHandGrab = {
                objectId: obj1.id,
                handIndices: [0, 1],
                initialDistance: initialDist,
                initialScale: obj1.entry.metadata.scale
            };

            // Clear single hand grab
            grabState.singleHandGrab = null;

            console.log('Two-hand grab started for scaling');
        }
    } else if (pinchingHands.length === 1 && !grabState.singleHandGrab && !grabState.twoHandGrab) {
        // Single hand pinch - start grab
        const pinch = pinchingHands[0];
        const obj = findObjectAtPoint(pinch.pinchCenter.x, pinch.pinchCenter.y);

        if (obj) {
            grabState.singleHandGrab = {
                objectId: obj.id,
                handIndex: hands.findIndex(h => detectPinch(h)?.isPinching),
                initialPos: obj.entry.metadata.position,
                grabOffset: {
                    x: obj.entry.metadata.position.x - screenToWorld(pinch.pinchCenter.x, pinch.pinchCenter.y, obj.entry.metadata.position.z).x,
                    y: obj.entry.metadata.position.y - screenToWorld(pinch.pinchCenter.x, pinch.pinchCenter.y, obj.entry.metadata.position.z).y
                }
            };
            console.log('Single hand grab started');
        }
    }

    // Handle two-hand scaling
    if (grabState.twoHandGrab && pinchingHands.length === 2) {
        const dx = pinchingHands[1].pinchCenter.x - pinchingHands[0].pinchCenter.x;
        const dy = pinchingHands[1].pinchCenter.y - pinchingHands[0].pinchCenter.y;
        const currentDist = Math.sqrt(dx * dx + dy * dy);

        const scaleFactor = currentDist / grabState.twoHandGrab.initialDistance;
        const newScale = grabState.twoHandGrab.initialScale * scaleFactor;

        // Update object scale
        const entry = cadMeshes.get(grabState.twoHandGrab.objectId);
        if (entry) {
            entry.metadata.scale = Math.max(0.1, Math.min(5.0, newScale));
            entry.metadata.grabbed = true;
            emitCadState();
        }
    } else if (grabState.twoHandGrab && pinchingHands.length === 1 && !grabState.rotationMode) {
        // One hand released from two-hand grab - enter rotation mode
        const pinchingHandIndex = hands.findIndex(h => detectPinch(h)?.isPinching);
        const releasedHandIndex = pinchingHandIndex === 0 ? 1 : 0;

        // The released hand (now open) controls rotation
        const rotationHand = hands[releasedHandIndex];

        if (rotationHand) {
            grabState.rotationMode = {
                objectId: grabState.twoHandGrab.objectId,
                rotationHandIndex: releasedHandIndex,
                anchorHandIndex: pinchingHandIndex,
                lastPos: rotationHand.landmarks[0], // wrist position
                rotationAxis: rotationHand.handedness === 'Left' ? 'x' : 'y'  // Left hand = X-axis, Right hand = Y-axis
            };

            console.log(`Rotation mode activated - ${rotationHand.handedness} hand controls ${grabState.rotationMode.rotationAxis}-axis`);
        }

        // Keep two-hand grab active (don't clear it yet)
    } else if (grabState.twoHandGrab && pinchingHands.length === 0) {
        // Both hands released - exit rotation mode and two-hand grab
        const entry = cadMeshes.get(grabState.twoHandGrab.objectId);
        if (entry) {
            entry.metadata.grabbed = false;
            emitCadState();
        }
        grabState.twoHandGrab = null;
        grabState.rotationMode = null;
        console.log('Two-hand grab and rotation mode released');
    }

    // Handle single hand move
    if (grabState.singleHandGrab && pinchingHands.length >= 1) {
        const pinch = pinchingHands.find((p, i) => hands[i].handIndex === grabState.singleHandGrab.handIndex) || pinchingHands[0];
        const entry = cadMeshes.get(grabState.singleHandGrab.objectId);

        if (entry && pinch) {
            const worldPos = screenToWorld(pinch.pinchCenter.x, pinch.pinchCenter.y, entry.metadata.position.z);
            entry.metadata.position.x = worldPos.x + grabState.singleHandGrab.grabOffset.x;
            entry.metadata.position.y = worldPos.y + grabState.singleHandGrab.grabOffset.y;
            entry.metadata.grabbed = true;
            emitCadState();
        }
    } else if (grabState.singleHandGrab && pinchingHands.length === 0) {
        // Release single hand grab
        const entry = cadMeshes.get(grabState.singleHandGrab.objectId);
        if (entry) {
            entry.metadata.grabbed = false;
            emitCadState();
        }
        grabState.singleHandGrab = null;
        console.log('Single hand grab released');
    }

    // Handle rotation mode
    if (grabState.rotationMode && hands.length >= 2) {
        const rotationHand = hands[grabState.rotationMode.rotationHandIndex];
        const anchorHand = hands[grabState.rotationMode.anchorHandIndex];

        // Check if anchor hand is still pinching
        const anchorPinch = detectPinch(anchorHand);

        if (anchorPinch && anchorPinch.isPinching && rotationHand) {
            const entry = cadMeshes.get(grabState.rotationMode.objectId);

            if (entry && entry.metadata) {
                // Get current wrist position of rotation hand
                const currentPos = rotationHand.landmarks[0]; // wrist
                const lastPos = grabState.rotationMode.lastPos;

                // Calculate movement delta
                const deltaX = currentPos.x - lastPos.x;
                const deltaY = currentPos.y - lastPos.y;

                // Movement threshold to avoid jitter
                const movementThreshold = 0.01;
                const rotationSensitivity = 3.0; // Adjust for desired rotation speed

                if (grabState.rotationMode.rotationAxis === 'x') {
                    // X-axis rotation (tilt) - controlled by vertical hand movement
                    if (Math.abs(deltaY) > movementThreshold) {
                        const rotationDelta = -deltaY * rotationSensitivity;
                        entry.metadata.rotation.x += rotationDelta;
                        entry.metadata.rotation.x = entry.metadata.rotation.x % (2 * Math.PI);
                        emitCadState();
                    }
                } else if (grabState.rotationMode.rotationAxis === 'y') {
                    // Y-axis rotation (spin) - controlled by horizontal hand movement
                    if (Math.abs(deltaX) > movementThreshold) {
                        const rotationDelta = -deltaX * rotationSensitivity;
                        entry.metadata.rotation.y += rotationDelta;
                        entry.metadata.rotation.y = entry.metadata.rotation.y % (2 * Math.PI);
                        emitCadState();
                    }
                }

                // Update last position for next frame
                grabState.rotationMode.lastPos = currentPos;
            }
        } else {
            // Anchor hand released or rotation hand missing - exit rotation mode
            grabState.rotationMode = null;
            console.log('Rotation mode exited');
        }
    } else if (grabState.rotationMode && hands.length < 2) {
        // Not enough hands detected - exit rotation mode
        grabState.rotationMode = null;
        console.log('Rotation mode exited - hands lost');
    }
}

function emitCadState() {
    if (!socket || !roomId) return;

    const objects = [];
    cadMeshes.forEach((entry, id) => {
        if (entry.metadata) {
            objects.push({
                id: entry.metadata.id,
                name: entry.metadata.name,
                type: 'cad',
                position: entry.metadata.position,
                rotation: entry.metadata.rotation,
                scale: entry.metadata.scale,
                grabbed: entry.metadata.grabbed
            });
        }
    });

    socket.emit('cad-state', { roomId, state: { objects } });
}

// Update onHandsResults to store current hand data for 3D controls
const originalOnHandsResults = onHandsResults;
onHandsResults = function(results) {
    // Store for 3D processing
    currentHandResults = results;

    // Draw hands on expert's local overlay
    if (expertHandCanvas && results) {
        drawExpertHands(results);
    }

    // Call original handler
    originalOnHandsResults(results);
};

// -----------------------------
// Expert Local Hand Visualization
// -----------------------------

let expertHandCanvas = null;
let expertHandCtx = null;

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

function initExpertHandOverlay() {
    const videoWrapper = document.querySelector('.video-wrapper');
    if (!videoWrapper || expertHandCanvas) return;

    expertHandCanvas = document.createElement('canvas');
    expertHandCanvas.id = 'expertHandOverlay';
    expertHandCanvas.style.cssText = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 20;';
    videoWrapper.appendChild(expertHandCanvas);
    expertHandCtx = expertHandCanvas.getContext('2d');

    // Size canvas to match container
    const rect = videoWrapper.getBoundingClientRect();
    expertHandCanvas.width = rect.width * (window.devicePixelRatio || 1);
    expertHandCanvas.height = rect.height * (window.devicePixelRatio || 1);

    console.log('Expert hand overlay initialized');
}

function drawExpertHands(results) {
    if (!expertHandCtx || !expertHandCanvas) return;

    const width = expertHandCanvas.width;
    const height = expertHandCanvas.height;

    // Clear canvas
    expertHandCtx.clearRect(0, 0, width, height);

    if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        return;
    }

    // Colors for different hands
    const handColors = [
        'rgba(0, 255, 100, 0.9)',   // Green for first hand
        'rgba(255, 200, 0, 0.9)'    // Yellow for second hand
    ];

    // Draw each hand
    results.multiHandLandmarks.forEach((landmarks, handIdx) => {
        const color = handColors[handIdx % handColors.length];
        const handedness = results.multiHandedness && results.multiHandedness[handIdx] ? results.multiHandedness[handIdx].label : '';

        // Draw connections
        expertHandCtx.lineCap = 'round';
        expertHandCtx.lineJoin = 'round';
        expertHandCtx.strokeStyle = color;
        expertHandCtx.lineWidth = Math.max(3, Math.min(width, height) * 0.008);

        HAND_CONNECTIONS.forEach(([a, b]) => {
            const pa = landmarks[a];
            const pb = landmarks[b];
            if (!pa || !pb) return;
            const ax = pa.x * width;
            const ay = pa.y * height;
            const bx = pb.x * width;
            const by = pb.y * height;
            expertHandCtx.beginPath();
            expertHandCtx.moveTo(ax, ay);
            expertHandCtx.lineTo(bx, by);
            expertHandCtx.stroke();
        });

        // Draw joints
        expertHandCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        const r = Math.max(3, Math.min(width, height) * 0.006);
        landmarks.forEach((p) => {
            const x = p.x * width;
            const y = p.y * height;
            expertHandCtx.beginPath();
            expertHandCtx.arc(x, y, r, 0, Math.PI * 2);
            expertHandCtx.fill();
        });

        // Draw hand label
        if (handedness) {
            const wrist = landmarks[0];
            if (wrist) {
                const labelX = wrist.x * width;
                const labelY = wrist.y * height - 30;
                expertHandCtx.fillStyle = color;
                expertHandCtx.font = 'bold 20px Arial';
                expertHandCtx.textAlign = 'center';
                expertHandCtx.fillText(handedness, labelX, labelY);
            }
        }

        // Draw pinch indicator
        const pinch = detectPinch({ landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })) });
        if (pinch && pinch.isPinching) {
            const px = pinch.pinchCenter.x * width;
            const py = pinch.pinchCenter.y * height;
            expertHandCtx.fillStyle = 'rgba(255, 0, 0, 0.7)';
            expertHandCtx.beginPath();
            expertHandCtx.arc(px, py, 15, 0, Math.PI * 2);
            expertHandCtx.fill();
            expertHandCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            expertHandCtx.lineWidth = 3;
            expertHandCtx.stroke();
        }
    });
}

// Resize handler
window.addEventListener('resize', () => {
    if (expertHandCanvas) {
        const videoWrapper = document.querySelector('.video-wrapper');
        if (videoWrapper) {
            const rect = videoWrapper.getBoundingClientRect();
            expertHandCanvas.width = rect.width * (window.devicePixelRatio || 1);
            expertHandCanvas.height = rect.height * (window.devicePixelRatio || 1);
        }
    }
});

