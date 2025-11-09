const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Serve static files for both apps
app.use('/clinician', express.static(path.join(__dirname, '../clinician-app')));
app.use('/expert', express.static(path.join(__dirname, '../expert-app')));

// In-memory storage for latest expert hand landmarks per room
const lastSkeletonByRoom = new Map();

// Expose latest hand landmarks for a given room
// Example: GET /expert/hand-landmarks?roomId=ROOM123
app.get('/expert/hand-landmarks', (req, res) => {
  const roomId = req.query.roomId;
  if (!roomId) {
    return res.status(400).json({ error: 'roomId is required' });
  }
  const data = lastSkeletonByRoom.get(roomId) || null;
  res.json({
    roomId,
    data,
  });
});

// Also expose under /api to avoid any static route conflicts:
// Example: GET /api/hand-landmarks?roomId=ROOM123
app.get('/api/hand-landmarks', (req, res) => {
  const roomId = req.query.roomId;
  if (!roomId) {
    return res.status(400).json({ error: 'roomId is required' });
  }
  const data = lastSkeletonByRoom.get(roomId) || null;
  res.json({
    roomId,
    data,
  });
});

// Root route - show selection page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Medical Video Communication System</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 40px;
          max-width: 800px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 32px;
        }
        .subtitle {
          color: #666;
          margin-bottom: 40px;
          font-size: 16px;
        }
        .cards {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 30px;
        }
        .card {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 15px;
          padding: 30px;
          text-align: center;
          cursor: pointer;
          transition: transform 0.3s, box-shadow 0.3s;
          text-decoration: none;
          color: white;
        }
        .card:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        .icon {
          font-size: 48px;
          margin-bottom: 15px;
        }
        .card h2 {
          margin-bottom: 10px;
          font-size: 24px;
        }
        .card p {
          font-size: 14px;
          opacity: 0.9;
        }
        .info {
          background: #f7f9fc;
          border-radius: 10px;
          padding: 20px;
          margin-top: 30px;
        }
        .info h3 {
          color: #333;
          margin-bottom: 10px;
        }
        .info p {
          color: #666;
          line-height: 1.6;
          margin-bottom: 10px;
        }
        @media (max-width: 600px) {
          .cards { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏥 Medical Video Communication</h1>
        <p class="subtitle">Real-time telemedicine consultation platform</p>
        
        <div class="cards">
          <a href="/clinician" class="card">
            <div class="icon">👨‍⚕️</div>
            <h2>Clinician</h2>
            <p>Stream your camera to remote experts</p>
          </a>
          
          <a href="/expert" class="card">
            <div class="icon">🩺</div>
            <h2>Expert</h2>
            <p>View stream and provide guidance</p>
          </a>
        </div>
        
        <div class="info">
          <h3>📋 How to use:</h3>
          <p><strong>1.</strong> Clinician clicks "Clinician" and starts streaming</p>
          <p><strong>2.</strong> Expert clicks "Expert" and joins with the same Room ID</p>
          <p><strong>3.</strong> Both users can now communicate in real-time!</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Store active rooms and users
const rooms = new Map();
const users = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join room as clinician or expert
  socket.on('join-room', ({ roomId, role, userName }) => {
    socket.join(roomId);
    
    // Store user info
    users.set(socket.id, { roomId, role, userName });
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { clinician: null, experts: [] });
    }
    
    const room = rooms.get(roomId);
    
    if (role === 'clinician') {
      room.clinician = socket.id;
    } else if (role === 'expert') {
      room.experts.push(socket.id);
    }
    
    console.log(`${userName} (${role}) joined room ${roomId}`);
    
    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      role,
      userName
    });
    
    // Send current room state to the new user
    const roomUsers = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .map(id => {
        const user = users.get(id);
        return { userId: id, ...user };
      });
    
    socket.emit('room-users', roomUsers);
  });

  // WebRTC signaling - offer
  socket.on('offer', ({ offer, targetId }) => {
    console.log('Sending offer from', socket.id, 'to', targetId);
    io.to(targetId).emit('offer', {
      offer,
      senderId: socket.id
    });
  });

  // WebRTC signaling - answer
  socket.on('answer', ({ answer, targetId }) => {
    console.log('Sending answer from', socket.id, 'to', targetId);
    io.to(targetId).emit('answer', {
      answer,
      senderId: socket.id
    });
  });

  // WebRTC signaling - ICE candidate
  socket.on('ice-candidate', ({ candidate, targetId }) => {
    console.log('Sending ICE candidate from', socket.id, 'to', targetId);
    io.to(targetId).emit('ice-candidate', {
      candidate,
      senderId: socket.id
    });
  });

  // Handle annotations from expert
  socket.on('annotation', ({ roomId, annotation }) => {
    console.log('Broadcasting annotation to room:', roomId);
    // Broadcast to everyone except sender
    socket.to(roomId).emit('annotation', {
      annotation,
      senderId: socket.id,
      timestamp: Date.now()
    });
  });

  // Clear annotations
  socket.on('clear-annotations', ({ roomId }) => {
    console.log('Clearing annotations in room:', roomId);
    socket.to(roomId).emit('clear-annotations');
  });

  // Hand skeleton streaming (expert -> clinician)
  socket.on('hand-skeleton', ({ roomId, skeleton }) => {
    // skeleton: { landmarks: [{x,y,z}...], handedness?: 'Left'|'Right', clear?: boolean, ts?: number }
    if (!roomId) {
      return;
    }
    // Store latest for polling access
    try {
      lastSkeletonByRoom.set(roomId, {
        skeleton,
        updatedAt: Date.now(),
        senderId: socket.id,
      });
    } catch (e) {
      // no-op
    }
    // Broadcast to everyone else in the room
    socket.to(roomId).emit('hand-skeleton', {
      skeleton,
      senderId: socket.id,
      timestamp: Date.now()
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const user = users.get(socket.id);
    if (user) {
      const { roomId, role, userName } = user;
      
      // Clean up room data
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        if (role === 'clinician' && room.clinician === socket.id) {
          room.clinician = null;
        } else if (role === 'expert') {
          room.experts = room.experts.filter(id => id !== socket.id);
        }
        
        // Remove room if empty
        if (!room.clinician && room.experts.length === 0) {
          rooms.delete(roomId);
        }
      }
      
      // Notify others
      io.to(roomId).emit('user-left', {
        userId: socket.id,
        role,
        userName
      });
      
      users.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});