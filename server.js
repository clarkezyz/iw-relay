const WebSocket = require('ws');
const http = require('http');
const url = require('url');

class ImpossibleWriterRelay {
  constructor() {
    this.rooms = new Map(); // roomId -> Set of WebSocket connections
    this.userRates = new Map(); // connectionId -> rate limit tracker
    this.roomExpiry = new Map(); // roomId -> expiry timestamp

    // Rate limiting: 100 messages per second per user
    this.RATE_LIMIT = 100;
    this.RATE_WINDOW = 1000; // 1 second

    // Room expiry: 24 hours
    this.ROOM_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in ms

    this.setupServer();
    this.startCleanupInterval();
  }

  setupServer() {
    // Create HTTP server for health checks
    this.server = http.createServer((req, res) => {
      const pathname = url.parse(req.url).pathname;

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          rooms: this.rooms.size,
          connections: this.getTotalConnections(),
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        }));
      } else {
        res.writeHead(404);
        res.end('Impossible Writer Relay - WebSocket endpoint only');
      }
    });

    // Create WebSocket server
    this.wss = new WebSocket.Server({
      server: this.server,
      path: '/room'
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    const port = process.env.PORT || 3000;
    this.server.listen(port, () => {
      console.log(`🚀 Impossible Writer Relay listening on port ${port}`);
      console.log(`📡 WebSocket endpoint: ws://localhost:${port}/room/{roomId}`);
      console.log(`💚 Health check: http://localhost:${port}/health`);
    });
  }

  handleConnection(ws, req) {
    const pathname = url.parse(req.url).pathname;
    const roomId = pathname.split('/').pop();

    if (!roomId || roomId === 'room') {
      ws.close(1008, 'Room ID required');
      return;
    }

    // Generate unique connection ID
    const connectionId = Math.random().toString(36).substr(2, 9);
    ws.connectionId = connectionId;
    ws.roomId = roomId;

    // Initialize rate limiting for this connection
    this.userRates.set(connectionId, {
      count: 0,
      resetTime: Date.now() + this.RATE_WINDOW
    });

    // Add to room
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    this.rooms.get(roomId).add(ws);

    // Update room expiry
    this.roomExpiry.set(roomId, Date.now() + this.ROOM_EXPIRY);

    console.log(`✅ User ${connectionId} joined room ${roomId} (${this.rooms.get(roomId).size} users)`);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      connectionId: connectionId,
      roomId: roomId,
      userCount: this.rooms.get(roomId).size
    }));

    // Broadcast user joined to others in room
    this.broadcastToRoom(roomId, {
      type: 'user-joined',
      connectionId: connectionId,
      userCount: this.rooms.get(roomId).size
    }, ws);

    // Handle incoming messages
    ws.on('message', (data) => {
      this.handleMessage(ws, data);
    });

    // Handle disconnection
    ws.on('close', () => {
      this.handleDisconnection(ws);
    });

    ws.on('error', (error) => {
      console.error(`❌ WebSocket error for ${connectionId}:`, error);
      this.handleDisconnection(ws);
    });
  }

  handleMessage(ws, data) {
    try {
      // Rate limiting check
      if (!this.checkRateLimit(ws.connectionId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }

      const message = JSON.parse(data);

      // Add connection info to message
      message.connectionId = ws.connectionId;
      message.timestamp = Date.now();

      // Validate message format
      if (!message.type) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message type required' }));
        return;
      }

      // Broadcast to all other users in the room
      this.broadcastToRoom(ws.roomId, message, ws);

    } catch (error) {
      console.error(`❌ Message handling error:`, error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  }

  handleDisconnection(ws) {
    if (!ws.roomId || !ws.connectionId) return;

    const room = this.rooms.get(ws.roomId);
    if (room) {
      room.delete(ws);

      // Broadcast user left
      this.broadcastToRoom(ws.roomId, {
        type: 'user-left',
        connectionId: ws.connectionId,
        userCount: room.size
      });

      // Clean up empty room
      if (room.size === 0) {
        this.rooms.delete(ws.roomId);
        this.roomExpiry.delete(ws.roomId);
        console.log(`🧹 Cleaned up empty room ${ws.roomId}`);
      } else {
        console.log(`👋 User ${ws.connectionId} left room ${ws.roomId} (${room.size} remaining)`);
      }
    }

    // Clean up rate limiting
    this.userRates.delete(ws.connectionId);
  }

  broadcastToRoom(roomId, message, excludeWs = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const messageStr = JSON.stringify(message);

    room.forEach(ws => {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    });
  }

  checkRateLimit(connectionId) {
    const now = Date.now();
    const rateData = this.userRates.get(connectionId);

    if (!rateData) return false;

    // Reset counter if window expired
    if (now > rateData.resetTime) {
      rateData.count = 0;
      rateData.resetTime = now + this.RATE_WINDOW;
    }

    // Check limit
    if (rateData.count >= this.RATE_LIMIT) {
      return false;
    }

    rateData.count++;
    return true;
  }

  startCleanupInterval() {
    // Clean up expired rooms every hour
    setInterval(() => {
      const now = Date.now();
      const expiredRooms = [];

      this.roomExpiry.forEach((expiry, roomId) => {
        if (now > expiry) {
          expiredRooms.push(roomId);
        }
      });

      expiredRooms.forEach(roomId => {
        const room = this.rooms.get(roomId);
        if (room) {
          // Close all connections in expired room
          room.forEach(ws => {
            ws.close(1000, 'Room expired after 24 hours');
          });

          this.rooms.delete(roomId);
          this.roomExpiry.delete(roomId);
          console.log(`⏰ Expired room ${roomId} after 24 hours`);
        }
      });

    }, 60 * 60 * 1000); // Run every hour
  }

  getTotalConnections() {
    let total = 0;
    this.rooms.forEach(room => {
      total += room.size;
    });
    return total;
  }
}

// Start the relay
new ImpossibleWriterRelay();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down Impossible Writer Relay gracefully...');
  process.exit(0);
});