# Impossible Writer Relay

**WebSocket relay server for real-time collaborative editing with Impossible Writer.**

A lightweight, production-ready relay server that enables peer-to-peer collaboration for [Impossible Writer](https://github.com/clarkezyz/impossible-writer). Handles room management, rate limiting, and automatic cleanup with zero data persistence.

---

## Features

### 🏠 **Room-Based Isolation**
Users join named rooms and only see messages from others in the same room. Perfect for document-specific collaboration.

### ⚡ **Sub-100ms Latency**
WebSocket-based message relay with minimal overhead. Messages are broadcast instantly to all room members.

### 🛡️ **Rate Limiting**
Built-in protection against abuse: 100 messages per second per user. Prevents flood attacks while allowing natural typing speed.

### 🧹 **Automatic Cleanup**
Rooms expire after 24 hours from creation. Empty rooms are cleaned up immediately when the last user leaves.

### 📊 **Health Monitoring**
`/health` and `/stats` endpoints for monitoring server status, memory usage, and connection statistics.

### 🔒 **Zero Data Persistence**
The relay server stores nothing. All messages are ephemeral - relayed to connected clients and immediately discarded.

---

## Why You Need This

**Impossible Writer** uses WebRTC for peer-to-peer collaboration, but WebRTC requires a relay server for:

1. **Signaling** - Initial connection setup between peers
2. **NAT traversal** - Connecting peers behind firewalls/routers
3. **Fallback relay** - When direct P2P connection fails

This relay server handles all three. Your data flows peer-to-peer when possible, through the relay when necessary.

**The relay never stores your content.** It only forwards WebSocket messages between connected peers in the same room.

---

## Quick Start

### **Run Locally**

```bash
# Clone the repository
git clone https://github.com/clarkezyz/iw-relay.git
cd iw-relay

# Install dependencies
npm install

# Start the server
node server.js
```

Server runs on `http://localhost:3000` by default.

### **Test the Server**

```bash
# Check health
curl http://localhost:3000/health

# Check statistics
curl http://localhost:3000/stats
```

### **Connect from Impossible Writer**

In your Impossible Writer configuration, set the relay URL:

```javascript
const RELAY_URL = 'ws://localhost:3000';
```

When creating/joining a room, Impossible Writer will connect to:
```
ws://localhost:3000/room/{roomId}
```

---

## Deployment

### **Deploy to Railway** (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Click "Deploy on Railway"
2. Connect your GitHub account
3. Railway auto-detects the Node.js app and deploys
4. Get your deployment URL: `your-app.railway.app`
5. Update Impossible Writer config: `wss://your-app.railway.app`

**Railway auto-assigns PORT** - no configuration needed.

### **Deploy to Heroku**

```bash
# Login to Heroku
heroku login

# Create app
heroku create your-relay-name

# Deploy
git push heroku main

# Get URL
heroku open
```

Use `wss://your-relay-name.herokuapp.com` in Impossible Writer.

### **Deploy to Render**

1. Create new **Web Service** on Render
2. Connect this GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Use the provided URL: `wss://your-app.onrender.com`

### **Deploy to VPS (DigitalOcean, Linode, etc.)**

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone https://github.com/clarkezyz/iw-relay.git
cd iw-relay
npm install

# Run with PM2 for auto-restart
npm install -g pm2
pm2 start server.js --name iw-relay
pm2 save
pm2 startup

# Setup nginx reverse proxy (optional but recommended)
# See "Production Setup" section below
```

---

## Configuration

### **Environment Variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | - | Set to `production` for JSON logs |

**Example:**

```bash
PORT=8080 LOG_LEVEL=debug node server.js
```

### **Programmatic Configuration**

```javascript
const ImpossibleWriterRelay = require('./server.js');

const relay = new ImpossibleWriterRelay({
  port: 3000,
  rateLimit: 100,              // messages per second
  rateLimitWindow: 1000,       // milliseconds
  roomExpiry: 24 * 60 * 60 * 1000,  // 24 hours
  cleanupInterval: 60 * 60 * 1000,  // 1 hour
  logLevel: 'info'             // debug, info, warn, error
});
```

---

## API Documentation

### **WebSocket Connection**

**Endpoint:**
```
ws://your-server.com/room/{roomId}
```

Or query-based:
```
ws://your-server.com/?room={roomId}
```

**Example:**
```javascript
const ws = new WebSocket('ws://localhost:3000/room/my-document');

ws.onopen = () => {
  console.log('Connected to relay');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};
```

### **Message Format**

All messages are JSON with a `type` field:

```json
{
  "type": "content",
  "data": {
    "operation": "insert",
    "position": 42,
    "text": "Hello"
  }
}
```

**Server adds metadata automatically:**
```json
{
  "type": "content",
  "connectionId": "3f4a9c2b1e5d8a7f",
  "timestamp": 1699459200000,
  "data": { ... }
}
```

### **Server Message Types**

| Type | When | Data |
|------|------|------|
| `connected` | User joins room | `{ connectionId, roomId, userCount }` |
| `user-joined` | Another user joins | `{ connectionId, userCount }` |
| `user-left` | User leaves room | `{ connectionId, userCount }` |
| `room-expired` | Room expired (24h) | `{ message }` |
| `server-shutdown` | Server shutting down | `{ message }` |
| `error` | Error occurred | `{ message, code }` |

### **Error Codes**

| Code | Meaning |
|------|---------|
| `RATE_LIMIT_EXCEEDED` | User sent > 100 msg/sec |
| `INVALID_MESSAGE` | Message missing `type` field |
| `PARSE_ERROR` | Invalid JSON |

### **HTTP Endpoints**

#### `GET /health`

Returns server health status:

```json
{
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2025-11-08T10:30:15.234Z",
  "rooms": 5,
  "connections": 12,
  "memory": {
    "heapUsed": "45MB",
    "heapTotal": "64MB"
  }
}
```

#### `GET /stats`

Returns detailed statistics:

```json
{
  "messagesRelayed": 15234,
  "connectionsTotal": 342,
  "disconnectionsTotal": 330,
  "rateLimitsHit": 3,
  "startTime": 1699459200000,
  "currentRooms": 5,
  "currentConnections": 12,
  "uptime": 3600,
  "uptimeFormatted": "1h"
}
```

---

## Production Setup

### **HTTPS/WSS with Nginx**

For production, use nginx as a reverse proxy to add SSL:

```nginx
server {
  listen 443 ssl;
  server_name relay.yourdomain.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Get free SSL with Let's Encrypt:
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d relay.yourdomain.com
```

Now use `wss://relay.yourdomain.com` in Impossible Writer.

### **Process Management with PM2**

Keep the server running with auto-restart:

```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start server.js --name iw-relay

# Configure for system startup
pm2 startup
pm2 save

# Monitor
pm2 monit

# View logs
pm2 logs iw-relay
```

### **Monitoring**

**With PM2:**
```bash
pm2 monit
```

**With health endpoint:**
```bash
# Setup cron job to check health every minute
* * * * * curl -f http://localhost:3000/health || systemctl restart iw-relay
```

**With external monitoring:**
- Uptime Robot: Monitor `https://your-relay.com/health`
- Pingdom: Check response time
- CloudWatch/Datadog: Parse JSON logs

### **Logging**

**Development mode** (pretty print):
```
[2025-11-08T10:30:15.234Z] ℹ️  INFO: User joined room { connectionId: '3f4a9c2b...', roomId: 'doc-123', userCount: 2 }
```

**Production mode** (JSON for log aggregation):
```bash
NODE_ENV=production node server.js
```

```json
{"timestamp":"2025-11-08T10:30:15.234Z","level":"INFO","message":"User joined room","connectionId":"3f4a9c2b1e5d8a7f","roomId":"doc-123","userCount":2}
```

Ship logs to CloudWatch, Datadog, or any JSON log processor.

---

## Security Considerations

### **Rate Limiting**

Built-in: 100 messages/second per user. Prevents:
- Flood attacks
- Accidental infinite loops
- Resource exhaustion

Adjust if needed:
```javascript
new ImpossibleWriterRelay({ rateLimit: 200 });
```

### **Room ID Validation**

Only alphanumeric, dash, and underscore allowed. Prevents:
- Path traversal attacks
- Injection attacks
- Invalid characters breaking routing

### **No Authentication**

The relay server has **no authentication** by design. Anyone who knows a room ID can join.

**Why?** Impossible Writer is designed for:
- Private collaboration (room IDs are secrets)
- Temporary sessions (rooms expire after 24h)
- Zero-knowledge relay (server doesn't know what's in messages)

**If you need authentication:**
- Add token validation in `handleConnection()`
- Verify JWT tokens before allowing room access
- Integrate with your existing auth system

**Example:**
```javascript
handleConnection(ws, req) {
  const token = parsedUrl.query.token;

  if (!verifyToken(token)) {
    ws.close(1008, 'Invalid authentication token');
    return;
  }

  // ... rest of connection logic
}
```

### **CORS / Origin Checking**

By default, the relay accepts WebSocket connections from **any origin**.

**To restrict origins:**
```javascript
this.wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  const allowedOrigins = ['https://yourdomain.com'];

  if (!allowedOrigins.includes(origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  this.handleConnection(ws, req);
});
```

### **DDoS Protection**

For public deployment, add rate limiting at the nginx level:

```nginx
limit_req_zone $binary_remote_addr zone=relay:10m rate=10r/s;

server {
  location / {
    limit_req zone=relay burst=20;
    # ... proxy config
  }
}
```

Or use Cloudflare for DDoS protection (supports WebSockets on paid plans).

---

## Architecture

### **How It Works**

1. **User A** opens Impossible Writer, creates room `my-doc`
2. **User A's browser** connects to `ws://relay-server.com/room/my-doc`
3. **Relay server** creates room, stores WebSocket connection
4. **User B** joins same room `my-doc`
5. **User B's browser** connects to same room
6. **User A types** "Hello"
7. **User A's browser** sends message via WebSocket: `{ type: 'content', data: {...} }`
8. **Relay server** broadcasts message to all other connections in `my-doc` (User B)
9. **User B's browser** receives message, updates editor

**The relay never stores the message content.** It's forwarded and forgotten.

### **Room Lifecycle**

```
Room Created (first user joins)
    ↓
Set expiry time (now + 24h)
    ↓
Users join/leave (expiry time unchanged)
    ↓
Last user leaves → Room deleted immediately
    ↓
OR: 24 hours pass → Room expires, all users disconnected
```

### **Memory Usage**

**Per room:** ~200 bytes (Set, expiry timestamp)
**Per connection:** ~500 bytes (WebSocket, rate limiter, metadata)

**Example:** 100 rooms with average 3 users each = ~170KB RAM

**Cleanup:** Empty rooms deleted immediately. Expired rooms cleaned every hour.

---

## Troubleshooting

### **"Port already in use" error**

```bash
# Find process using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>

# Or use different port
PORT=8080 node server.js
```

### **WebSocket connection fails**

**Check firewall:**
```bash
sudo ufw allow 3000
```

**Check if server is running:**
```bash
curl http://localhost:3000/health
```

**Test WebSocket:**
```bash
npm install -g wscat
wscat -c ws://localhost:3000/room/test
```

### **High memory usage**

Check stats:
```bash
curl http://localhost:3000/stats
```

If `currentRooms` or `currentConnections` is very high:
- Reduce `roomExpiry` (rooms expire faster)
- Reduce `cleanupInterval` (cleanup runs more often)
- Add connection limits per room

### **Messages not being relayed**

**Check logs:**
```bash
LOG_LEVEL=debug node server.js
```

Look for:
- "Rate limit exceeded" (user sending too fast)
- "Invalid message" (malformed JSON)
- "WebSocket error" (connection issues)

### **Room expired too early**

Rooms expire 24 hours after **creation**, not last activity.

If a room should last longer:
```javascript
new ImpossibleWriterRelay({
  roomExpiry: 48 * 60 * 60 * 1000  // 48 hours
});
```

---

## Development

### **Running Tests**

```bash
npm test
```

(Tests coming soon - PRs welcome!)

### **Code Structure**

```
server.js
├── ImpossibleWriterRelay (class)
│   ├── constructor()          # Initialize config, state
│   ├── setupServer()          # HTTP + WebSocket servers
│   ├── handleConnection()     # New user joins room
│   ├── handleMessage()        # User sends message
│   ├── handleDisconnection()  # User leaves room
│   ├── broadcastToRoom()      # Send to all in room
│   ├── checkRateLimit()       # Enforce 100 msg/sec
│   ├── startCleanupInterval() # Expire old rooms
│   └── shutdown()             # Graceful shutdown
└── Process handlers (SIGTERM, uncaughtException, etc.)
```

### **Adding Features**

**Example: Add user nicknames**

```javascript
handleConnection(ws, req) {
  // ... existing code ...

  const nickname = parsedUrl.query.nickname || 'Anonymous';
  ws.nickname = nickname;

  this.broadcastToRoom(roomId, {
    type: 'user-joined',
    connectionId: connectionId,
    nickname: nickname,  // Add nickname
    userCount: userCount
  }, ws);
}
```

**Example: Add message persistence (if you really want it)**

```javascript
handleMessage(ws, data) {
  // ... existing code ...

  // Store last 100 messages per room
  if (!this.roomHistory.has(ws.roomId)) {
    this.roomHistory.set(ws.roomId, []);
  }

  const history = this.roomHistory.get(ws.roomId);
  history.push(message);

  if (history.length > 100) {
    history.shift(); // Keep only last 100
  }

  // Broadcast as usual...
}
```

---

## FAQ

### **Do I need to run my own relay?**

**No.** The public relay at `wss://iw-relay.railway.app` is available for anyone using Impossible Writer.

**But you might want to if:**
- You're deploying Impossible Writer for an organization (control, privacy)
- You need custom rate limits or room expiry times
- You want guaranteed uptime (SLA)
- You need to log/monitor your specific usage

### **How much does it cost to run?**

**Free tier options:**
- **Railway:** $5/month credit (enough for low-traffic relay)
- **Render:** Free tier (auto-sleeps after inactivity)
- **Heroku:** Eco plan $5/month

**Paid hosting:**
- **DigitalOcean Droplet:** $6/month (512MB, plenty for relay)
- **Linode Nanode:** $5/month
- **AWS EC2 t2.micro:** Free tier, then ~$10/month

**Expected resources:**
- 100 concurrent users: ~50MB RAM, <1% CPU
- 1000 concurrent users: ~200MB RAM, ~5% CPU

### **Can multiple Impossible Writer instances share one relay?**

**Yes.** The relay is stateless and room-based. Different apps can use the same relay server - they just need different room IDs.

### **What happens if the relay goes down?**

Users lose real-time collaboration until it comes back up. Local editing continues to work (Impossible Writer still functions as a single-user editor).

When the relay reconnects:
- Users need to manually refresh to rejoin room
- Document state might diverge (no automatic conflict resolution)

**Mitigation:**
- Use PM2 for auto-restart
- Deploy to multiple regions (load balancer)
- Add reconnection logic in Impossible Writer client

### **Is this relay compatible with other WebRTC apps?**

**Not out of the box.** The message format is specific to Impossible Writer's operational transform algorithm.

**But you could adapt it for:**
- Other collaborative editors
- Real-time chat apps
- Multiplayer games
- Any WebSocket-based signaling needs

The core broadcast logic is generic - just change the message handling.

---

## Contributing

Contributions welcome! This project values:

- **Simplicity** - Keep it lightweight and easy to deploy
- **Zero persistence** - Never store user data
- **Production-ready** - Proper logging, error handling, graceful shutdown
- **Documentation** - Clear comments and examples

### **Ideas for Contribution**

- Unit tests (Jest, Mocha)
- Docker support
- Prometheus metrics endpoint
- Per-room message history (opt-in)
- Admin dashboard (view active rooms/connections)
- Horizontal scaling (Redis pub/sub)
- TypeScript conversion

---

## License

MIT License - See LICENSE file for details

Free for personal and commercial use. Attribution appreciated but not required.

---

## Credits

**Built by Clarke Zyz** - 2025

Part of the [Impossible Writer](https://github.com/clarkezyz/impossible-writer) project.

### **Acknowledgments**

- [ws](https://github.com/websockets/ws) - Fast WebSocket library
- Railway, Heroku, Render - Easy deployment platforms
- Everyone who believes collaborative editing shouldn't require giving your data to a corporation

---

## Support

**Issues:** [GitHub Issues](https://github.com/clarkezyz/iw-relay/issues)
**Impossible Writer:** [Main Project](https://github.com/clarkezyz/impossible-writer)

---

**Impossible Writer Relay** - Real-time collaboration without the surveillance.

*Relay • Don't Store • Expire*
