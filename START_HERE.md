# 🎯 START HERE - Two Computer Setup

## ⚡ TL;DR - Fastest Path to Get Running

### Prerequisites (One-time setup):
```bash
# 1. Install ngrok (if not installed)
brew install ngrok   # Mac
# Or download from: https://ngrok.com/download

# 2. Sign up for ngrok (FREE) and authenticate
# Get token from: https://dashboard.ngrok.com/get-started/your-authtoken
ngrok config add-authtoken YOUR_AUTH_TOKEN

# 3. Verify setup
./test-setup.sh
```

### Run It Now (Every time):

**Computer 1 (Host):**
```bash
# Just run this one command:
./start-with-ngrok.sh
# → Copy the ngrok URL that appears (https://xxxxx.ngrok.io)
```

**THAT'S IT!** Now share the ngrok URL with others.

**Anyone with the URL can access:**
- Clinician app: `https://xxxxx.ngrok.io/clinician`
- Expert app: `https://xxxxx.ngrok.io/expert`
- Main page: `https://xxxxx.ngrok.io/` (choose your role)

**No files needed on other computers - just the URL!**

## 📚 Documentation Guide

Pick based on your needs:

| File | When to Use |
|------|-------------|
| `QUICK_NGROK_SETUP.md` | Quick 5-minute setup guide |
| `TWO_COMPUTER_SETUP.txt` | Visual diagrams and checklists |
| `DEPLOYMENT_GUIDE.md` | Detailed troubleshooting |
| `README.md` | Full project documentation |
| `TROUBLESHOOTING.md` | Camera and permission issues |

## ✅ Quick Test

Test locally first:
```bash
# Terminal - Start the server
./start-with-ngrok.sh
# → Copy the ngrok URL

# Open 2 browser tabs:
# Tab 1: https://YOUR-NGROK-URL/clinician
# Tab 2: https://YOUR-NGROK-URL/expert
# Use the same room ID in both tabs
```

## 🆘 Common Issues

**"npx command not found"**
→ Install Node.js from https://nodejs.org

**"ngrok: command not found"**
→ Install: `brew install ngrok` or download from https://ngrok.com/download

**"Connection failed"**
→ Both computers must use the SAME ngrok URL and room ID

**"Session expired after 2 hours"**
→ ngrok free tier limit. Restart `./start-with-ngrok.sh` and use new URL

**"Camera not working"**
→ See `TROUBLESHOOTING.md`

## 🎯 What You Need to Know

1. **ngrok URL** - Changes every time you restart (free tier)
2. **Room ID** - Must be identical on both computers
3. **Start Order** - Computer 1 (clinician) starts streaming first
4. **Both Computers Need** - Modern browser, internet connection
5. **Only Computer 1 Needs** - Node.js, ngrok, this codebase

## 🚀 Ready?

Run this to verify everything:
```bash
./test-setup.sh
```

If it says "System is ready", you're good to go!

Then run:
```bash
./start-with-ngrok.sh
```

And follow the instructions on screen.

---

**Questions?** Check `TWO_COMPUTER_SETUP.txt` for detailed visual guide.

**Still stuck?** See `DEPLOYMENT_GUIDE.md` for comprehensive troubleshooting.

Good luck! 🏥

