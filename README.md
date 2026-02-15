# MikroRoom

Ultralight video meeting tool. Uses WebRTC - zero frameworks, zero bloat.

## Features

- **Zero dependencies** - Pure Node.js + TypeScript
- **WebRTC** - P2P video/audio with SFU-like signaling
- **Modern vanilla stack** - No React, no frameworks
- **Clean architecture** - Modular, tested, maintainable

## Quick Start

```bash
# Install dependencies
npm install

# Development mode (uses HTTP, localhost:3000)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests
npm test

# Lint code
npm run lint
```

Then open `http://localhost:3000` in your browser.

## Configuration

MikroRoom works out of the box with zero configuration! However, you may want to configure:

- **API URL** - When hosting frontend separately from backend
- **STUN/TURN servers** - For better connectivity behind NAT/firewalls
- **HTTPS/SSL** - Required for production and camera access
- **Port** - Custom port number

See [CONFIGURATION.md](./CONFIGURATION.md) for detailed setup instructions.

### Quick Configuration

**1. Frontend Runtime Config** (for API URL, ICE servers):
Edit `static/mikroroom.config.json`:

```json
{
  "apiUrl": "wss://api.yourdomain.com/ws",
  "iceServers": [
    { "urls": "stun:stun.cloudflare.com:3478" }
  ]
}
```

**2. Server Environment Config** (for port, HTTPS, TURN):
Create a `.env` file:

```bash
PORT=8080
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_SERVER_USERNAME=your-username
TURN_SERVER_CREDENTIAL=your-password
```

## Production Deployment

### Minimal Setup (works for most cases)

```bash
npm install
npm run build
PORT=8080 npm start
```

### Recommended Setup (with TURN server)

```bash
# Set environment variables
export PORT=443
export TURN_SERVER_URL=turn:your-server.com:3478
export TURN_SERVER_USERNAME=user
export TURN_SERVER_CREDENTIAL=pass

# Build and run
npm run build
npm start
```

### Using Docker

```bash
# Build image
docker build -t mikroroom .

# Run container
docker run -d -p 8080:8080 \
  -e PORT=8080 \
  -e TURN_SERVER_URL=turn:your-server.com:3478 \
  mikroroom
```

## See docs site for more

Visit [the docs site](https://docs.mikroroom.com) to get much more detailed instructions.
