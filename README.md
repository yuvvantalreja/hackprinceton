# 🏥 Medical Video Communication System

A real-time video streaming and annotation platform for medical consultations, built with **WebRTC**, **Socket.IO**, and vanilla JavaScript. This system enables on-site clinicians to stream their camera feed to remote medical experts who can view the stream and provide real-time visual guidance through annotations.

## 🌟 Features

### For Clinicians (Client A)
- 📹 **Live Camera Streaming** - Stream high-quality video to remote experts
- 🎤 **Audio Communication** - Two-way audio support
- 👁️ **Real-time Annotations** - View annotations placed by experts on the video feed
- 📊 **Connection Status** - Monitor expert connections and stream status
- 🎛️ **Media Controls** - Toggle camera and microphone on/off

### For Experts (Client B)
- 📺 **Live Video Viewing** - Watch clinician's camera feed in real-time
- 🎨 **Annotation Tools** - Place arrows and text annotations on the video
- 👇 **Arrow Pointers** - Point to specific areas of interest
- 💬 **Text Annotations** - Add textual guidance and notes
- 🗑️ **Clear Annotations** - Remove all annotations with one click
- ⏱️ **Auto-expiring Annotations** - Annotations automatically disappear after 5 seconds

### Signaling Server
- 🔄 **WebRTC Signaling** - Handles peer connection setup
- 🚦 **Room Management** - Supports multiple consultation rooms
- 👥 **User Tracking** - Tracks connected clinicians and experts
- 📡 **Real-time Communication** - Broadcasts annotations and user events

## 🏗️ Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Clinician App  │◄───────►│ Signaling Server │◄───────►│   Expert App    │
│   (Client A)    │         │   (Node.js +     │         │   (Client B)    │
│                 │         │    Socket.IO)    │         │                 │
│  - Streams cam  │         │                  │         │  - Views stream │
│  - Views annot. │         │  - WebRTC setup  │         │  - Sends annot. │
└─────────────────┘         │  - Room mgmt     │         └─────────────────┘
        │                   └──────────────────┘                  │
        │                                                          │
        └────────────── WebRTC P2P Connection ───────────────────┘
                     (Direct video/audio stream)
```

## 📦 Tech Stack

- **WebRTC** - Peer-to-peer video streaming
- **Socket.IO** - Real-time signaling and messaging
- **Node.js + Express** - Signaling server
- **Vanilla JavaScript** - Client applications
- **HTML5 + CSS3** - Modern, responsive UI

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Modern web browser with WebRTC support (Chrome, Firefox, Safari, Edge)
- Camera and microphone access

### Installation

1. **Clone or navigate to the project directory:**

```bash
cd hackprinceton_2024
```

2. **Install signaling server dependencies:**

```bash
cd signaling-server
npm install
```

3. **Install client app dependencies (optional, for development):**

```bash
cd ../clinician-app
npm install

cd ../expert-app
npm install
```

### Running the System

You need to run **three** separate servers:

#### 1. Start the Signaling Server (Terminal 1)

```bash
cd signaling-server
npm start
```

The server will start on `http://localhost:3001`

#### 2. Start the Clinician App (Terminal 2)

```bash
cd clinician-app
npm start
```

The app will be available at `http://localhost:3002`

#### 3. Start the Expert App (Terminal 3)

```bash
cd expert-app
npm start
```

The app will be available at `http://localhost:3003`

### Usage

1. **Open Clinician App** (`http://localhost:3002`):
   - Enter your name (e.g., "Dr. Smith")
   - Enter a room ID (e.g., "room-123")
   - Click "Start Streaming"
   - Grant camera and microphone permissions

2. **Open Expert App** (`http://localhost:3003`):
   - Enter your name (e.g., "Dr. Johnson")
   - Enter the **same room ID** as the clinician
   - Click "Join Session"

3. **Start Collaborating**:
   - Expert can now see the clinician's video feed
   - Expert can click on the video to place arrow annotations
   - Expert can add text annotations for guidance
   - Clinician will see all annotations in real-time
   - Annotations auto-expire after 5 seconds

## 📁 Project Structure

```
hackprinceton_2024/
├── signaling-server/          # WebRTC signaling server
│   ├── server.js              # Main server file
│   └── package.json           # Server dependencies
│
├── clinician-app/             # On-site clinician application
│   ├── index.html             # Main HTML
│   ├── styles.css             # Styling
│   ├── app.js                 # Client-side logic
│   └── package.json           # Development dependencies
│
├── expert-app/                # Remote expert application
│   ├── index.html             # Main HTML
│   ├── styles.css             # Styling
│   ├── app.js                 # Client-side logic
│   └── package.json           # Development dependencies
│
└── README.md                  # This file
```

## 🔧 Configuration

### Signaling Server

Edit `signaling-server/server.js` to change the port:

```javascript
const PORT = process.env.PORT || 3001;
```

### Client Apps

Edit the `SIGNALING_SERVER` constant in both `clinician-app/app.js` and `expert-app/app.js`:

```javascript
const SIGNALING_SERVER = 'http://localhost:3001';
```

For production, use your deployed server URL:

```javascript
const SIGNALING_SERVER = 'https://your-server.com';
```

## 🌐 Running on 2 Separate Computers

### Super Easy Setup with ngrok (Recommended)

Want to run this on 2 different computers? **It's incredibly simple!**

**📖 See:** [SUPER_SIMPLE_GUIDE.md](SUPER_SIMPLE_GUIDE.md) - The easiest guide ever!
**📖 Quick Reference:** [START_HERE.md](START_HERE.md) - Quick start
**📖 Detailed Guide:** [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - Complete troubleshooting

**The Process:**
1. Computer 1: Run `./start-with-ngrok.sh`
2. Copy the ngrok URL (e.g., `https://abc123.ngrok.io`)
3. **Send that URL to anyone** - they open it in a browser
4. That's it! No files needed on their computer.

**Everyone accesses:**
- Clinician: `https://your-url.ngrok.io/clinician`
- Expert: `https://your-url.ngrok.io/expert`
- Or visit: `https://your-url.ngrok.io/` to choose

**No installation needed on remote computers - just a browser!**

## 🌐 Production Deployment

### Deploying the Signaling Server

**Option 1: Heroku**

```bash
cd signaling-server
heroku create your-app-name
git init
git add .
git commit -m "Initial commit"
git push heroku master
```

**Option 2: Railway / Render / DigitalOcean**

1. Push your code to GitHub
2. Connect your repository to the platform
3. Set the build command: `npm install`
4. Set the start command: `npm start`
5. Add environment variable: `PORT=3001`

### Deploying Client Apps

**Option 1: Netlify / Vercel**

1. Drag and drop the `clinician-app` folder
2. Drag and drop the `expert-app` folder
3. Update the `SIGNALING_SERVER` URL in both apps

**Option 2: GitHub Pages**

```bash
# In each client app folder
git init
git add .
git commit -m "Deploy"
git push origin gh-pages
```

## 🔐 Security Considerations

For production deployment:

1. **Use HTTPS**: WebRTC requires HTTPS in production
2. **Add Authentication**: Implement user authentication
3. **Room Security**: Add room passwords or access tokens
4. **TURN Servers**: Add TURN servers for NAT traversal
5. **Rate Limiting**: Implement rate limiting on the signaling server
6. **CORS Configuration**: Restrict CORS to your domains

Example TURN server configuration:

```javascript
const pc = new RTCPeerConnection({
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'username',
            credential: 'password'
        }
    ]
});
```

## 🐛 Troubleshooting

### Video not showing

- Ensure camera permissions are granted
- Check browser console for errors
- Verify all three servers are running
- Try refreshing both pages

### Connection issues

- Check firewall settings
- Ensure both clients are using the same room ID
- Verify signaling server is accessible
- Check browser WebRTC support

### Annotations not appearing

- Ensure both clients are in the same room
- Check browser console for Socket.IO errors
- Verify signaling server logs

## 🚀 Advanced Features to Add

- [ ] Screen sharing capability
- [ ] Multiple expert support (multiple viewers)
- [ ] Recording functionality
- [ ] Chat messaging
- [ ] Drawing tools (circles, lines, freehand)
- [ ] Snapshot/screenshot feature
- [ ] Session history and replay
- [ ] Mobile app versions
- [ ] End-to-end encryption

## 📚 Resources

- [WebRTC Documentation](https://webrtc.org/)
- [Socket.IO Documentation](https://socket.io/docs/)
- [MDN WebRTC Guide](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [PeerJS Alternative](https://peerjs.com/) - For easier WebRTC implementation

## 🤝 Alternative Solutions

If you want faster setup with managed services:

1. **LiveKit** - [livekit.io](https://livekit.io)
   - Generous free tier
   - Built-in recording and streaming
   - SDKs for web and mobile

2. **Daily.co** - [daily.co](https://daily.co)
   - Simple API
   - Free tier available
   - Great for quick prototypes

3. **Agora** - [agora.io](https://agora.io)
   - Professional video quality
   - Global infrastructure
   - Free minutes included

## 📝 License

MIT License - feel free to use this for your projects!

## 👥 Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

---

Built with ❤️ for HackPrinceton 2024

