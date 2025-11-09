#!/bin/bash

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🏥 Starting Medical Video Communication System with ngrok${NC}\n"

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
    echo -e "${RED}ngrok is not installed.${NC}"
    echo -e "${YELLOW}Install ngrok:${NC}"
    echo -e "  Mac: brew install ngrok"
    echo -e "  Or download from: https://ngrok.com/download"
    exit 1
fi

# Install dependencies if needed
echo -e "${GREEN}Installing dependencies...${NC}\n"

cd signaling-server
if [ ! -d "node_modules" ]; then
    echo "Installing signaling server dependencies..."
    npm install
fi
cd ..

# Start signaling server in background
echo -e "${GREEN}Starting signaling server on port 3001...${NC}"
cd signaling-server
node server.js > ../server.log 2>&1 &
SIGNALING_PID=$!
cd ..

# Wait for signaling server to start
sleep 3

# Start ngrok tunnel
echo -e "${GREEN}Starting ngrok tunnel...${NC}"
ngrok http 3001 --log=stdout > ngrok.log 2>&1 &
NGROK_PID=$!

# Wait for ngrok to start and get the URL
sleep 3

# Check if ngrok authentication failed
if grep -q "authentication failed\|ERR_NGROK_4018" ngrok.log 2>/dev/null; then
    echo -e "${RED}❌ ngrok Authentication Failed!${NC}\n"
    echo -e "${YELLOW}ngrok requires a verified account and authtoken.${NC}\n"
    echo -e "${GREEN}To fix this:${NC}"
    echo -e "  1. Sign up for free: ${BLUE}https://dashboard.ngrok.com/signup${NC}"
    echo -e "  2. Get your authtoken: ${BLUE}https://dashboard.ngrok.com/get-started/your-authtoken${NC}"
    echo -e "  3. Run: ${YELLOW}ngrok config add-authtoken YOUR_AUTH_TOKEN${NC}\n"
    kill $SIGNALING_PID 2>/dev/null
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

# Extract ngrok URL from API
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*' | grep -o 'https://[^"]*' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo -e "${RED}Failed to get ngrok URL. Checking logs...${NC}"
    cat ngrok.log
    kill $SIGNALING_PID 2>/dev/null
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

echo -e "\n${GREEN}✅ System is ready! Both apps are now accessible!${NC}\n"
echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
echo -e "${BLUE}┃                  🎉 READY TO USE 🎉                           ┃${NC}"
echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
echo -e "\n${GREEN}🌐 Your Public URL:${NC}"
echo -e "   ${YELLOW}${NGROK_URL}${NC}"
echo -e "\n${BLUE}📋 Instructions - IT'S THIS EASY:${NC}\n"
echo -e "${GREEN}COMPUTER 1 (Clinician):${NC}"
echo -e "  1. Open browser"
echo -e "  2. Go to: ${YELLOW}${NGROK_URL}/clinician${NC}"
echo -e "  3. Enter your name and room ID"
echo -e "  4. Click 'Start Streaming'"
echo -e ""
echo -e "${GREEN}COMPUTER 2 (Expert):${NC}"
echo -e "  1. Open browser (no files needed!)"
echo -e "  2. Go to: ${YELLOW}${NGROK_URL}/expert${NC}"
echo -e "  3. Enter your name and SAME room ID"
echo -e "  4. Click 'Join Session'"
echo -e ""
echo -e "${GREEN}OR visit: ${YELLOW}${NGROK_URL}${NC} to choose your role${NC}"
echo -e ""
echo -e "${BLUE}💡 Important Notes:${NC}"
echo -e "  • Both users MUST use the same Room ID"
echo -e "  • No files needed on Computer 2 - just the URL!"
echo -e "  • Clinician should start streaming FIRST"
echo -e "  • ngrok free tier: 2-hour sessions (then restart)"
echo -e "  • Share this URL: ${YELLOW}${NGROK_URL}${NC}"
echo -e ""
echo -e "${BLUE}🔍 Monitoring:${NC}"
echo -e "  • Main page: ${YELLOW}${NGROK_URL}${NC}"
echo -e "  • ngrok dashboard: ${YELLOW}http://localhost:4040${NC}"
echo -e "  • Server logs: ${YELLOW}tail -f server.log${NC}"
echo -e ""

# Save ngrok URL to a file for reference
echo "$NGROK_URL" > ngrok-url.txt
echo -e "${GREEN}📝 ngrok URL saved to: ngrok-url.txt${NC}\n"

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Stopping all services...${NC}"
    kill $SIGNALING_PID 2>/dev/null
    kill $NGROK_PID 2>/dev/null
    rm -f ngrok-url.txt
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

# Trap Ctrl+C and call cleanup
trap cleanup INT

# Keep the script running
echo -e "${BLUE}Press Ctrl+C to stop all services${NC}\n"
wait

