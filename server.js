const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

/**
 * Impossible Writer Relay Server
 *
 * WebSocket relay for real-time collaborative editing.
 * Supports multiple rooms, rate limiting, and automatic cleanup.
 *
 * Features:
 * - Room-based isolation (users only see messages from their room)
 * - Rate limiting (100 msg/sec per user)
 * - Auto-expiry (rooms timeout after 24 hours of creation)
 * - Health monitoring endpoint
 * - Graceful shutdown
 */
class ImpossibleWriterRelay {
  constructor(config = {}) {
    // Configuration with defaults
    this.config = {
      port: process.env.PORT || config.port || 3000,
      rateLimit: config.rateLimit || 100,           // messages per second
      rateLimitWindow: config.rateLimitWindow || 1000, // milliseconds
      roomExpiry: config.roomExpiry || 24 * 60 * 60 * 1000, // 24 hours
      cleanupInterval: config.cleanupInterval || 60 * 60 * 1000, // 1 hour
      logLevel: process.env.LOG_LEVEL || config.logLevel || 'info' // debug, info, warn, error
    };

    // State management
    this.rooms = new Map();        // roomId -> Set of WebSocket connections
    this.userRates = new Map();    // connectionId -> { count, resetTime }
    this.roomExpiry = new Map();   // roomId -> expiry timestamp (creation time + 24h)
    this.stats = {
      messagesRelayed: 0,
      connectionsTotal: 0,
      disconnectionsTotal: 0,
      rateLimitsHit: 0,
      startTime: Date.now()
    };

    this.log('info', 'Initializing Impossible Writer Relay', {
      config: this.config
    });

    this.setupServer();
    this.startCleanupInterval();
  }

  /**
   * Structured logging with timestamp and log levels
   * Supports JSON output for log aggregation services
   */
  log(level, message, data = {}) {
    const levels = ['debug', 'info', 'warn', 'error'];
    const configLevel = levels.indexOf(this.config.logLevel);
    const messageLevel = levels.indexOf(level);

    if (messageLevel < configLevel) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...data
    };

    // JSON output for production, pretty print for development
    if (process.env.NODE_ENV === 'production') {
      console.log(JSON.stringify(logEntry));
    } else {
      const prefix = {
        debug: '🔍',
        info: 'ℹ️ ',
        warn: '⚠️ ',
        error: '❌'
      }[level] || '';
      console.log(`[${logEntry.timestamp}] ${prefix} ${level.toUpperCase()}: ${message}`,
        Object.keys(data).length > 0 ? data : '');
    }
  }

  /**
   * Setup HTTP server for health checks and WebSocket server for relay
   */
  setupServer() {
    try {
      // HTTP server handles health checks and provides 404 for other routes
      this.server = http.createServer((req, res) => {
        const pathname = url.parse(req.url).pathname;

        if (pathname === '/health') {
          this.handleHealthCheck(req, res);
        } else if (pathname === '/stats') {
          this.handleStats(req, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Impossible Writer Relay - Use WebSocket endpoint: ws://host/room/{roomId}');
        }
      });

      // WebSocket server piggybacks on HTTP server
      this.wss = new WebSocket.Server({
        server: this.server,
        clientTracking: false // We manage connections ourselves
      });

      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      this.wss.on('error', (error) => {
        this.log('error', 'WebSocket server error', { error: error.message });
      });

      // Start listening
      this.server.listen(this.config.port, () => {
        this.log('info', 'Server started', {
          port: this.config.port,
          wsEndpoint: `ws://localhost:${this.config.port}/room/{roomId}`,
          healthEndpoint: `http://localhost:${this.config.port}/health`,
          statsEndpoint: `http://localhost:${this.config.port}/stats`
        });
      });

      this.server.on('error', (error) => {
        this.log('error', 'HTTP server error', { error: error.message });
        if (error.code === 'EADDRINUSE') {
          this.log('error', `Port ${this.config.port} already in use`);
          process.exit(1);
        }
      });

    } catch (error) {
      this.log('error', 'Failed to setup server', { error: error.message });
      process.exit(1);
    }
  }

  /**
   * Health check endpoint - returns server status
   */
  handleHealthCheck(req, res) {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      rooms: this.rooms.size,
      connections: this.getTotalConnections(),
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));

    this.log('debug', 'Health check requested', health);
  }

  /**
   * Stats endpoint - returns detailed statistics
   */
  handleStats(req, res) {
    const stats = {
      ...this.stats,
      currentRooms: this.rooms.size,
      currentConnections: this.getTotalConnections(),
      uptime: process.uptime(),
      uptimeFormatted: this.formatUptime(process.uptime())
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  }

  /**
   * Handle new WebSocket connection
   * Validates room ID, initializes rate limiting, adds to room
   */
  handleConnection(ws, req) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    let roomId = null;

    // Support both path-based (/room/xyz) and query-based (/?room=xyz) room ID
    if (pathname.startsWith('/room/')) {
      const pathParts = pathname.split('/').filter(part => part.length > 0);
      if (pathParts.length >= 2) {
        roomId = pathParts[1];
      }
    } else if (query.room) {
      roomId = query.room;
    }

    // Reject connection if no room ID provided
    if (!roomId) {
      this.log('warn', 'Connection rejected - no room ID', {
        ip: req.socket.remoteAddress,
        url: req.url
      });
      ws.close(1008, 'Room ID required. Use /room/{roomId} or /?room={roomId}');
      return;
    }

    // Validate room ID format (alphanumeric, dash, underscore only)
    if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
      this.log('warn', 'Connection rejected - invalid room ID format', {
        roomId,
        ip: req.socket.remoteAddress
      });
      ws.close(1008, 'Invalid room ID format. Use alphanumeric characters, dash, or underscore only.');
      return;
    }

    // Generate cryptographically secure connection ID
    const connectionId = crypto.randomBytes(8).toString('hex');
    ws.connectionId = connectionId;
    ws.roomId = roomId;
    ws.joinedAt = Date.now();

    // Initialize rate limiting tracker for this connection
    this.userRates.set(connectionId, {
      count: 0,
      resetTime: Date.now() + this.config.rateLimitWindow
    });

    // Create room if it doesn't exist
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
      // Set expiry time when room is created (not when users join)
      this.roomExpiry.set(roomId, Date.now() + this.config.roomExpiry);
      this.log('info', 'Room created', { roomId });
    }

    // Add connection to room
    this.rooms.get(roomId).add(ws);
    this.stats.connectionsTotal++;

    const userCount = this.rooms.get(roomId).size;

    this.log('info', 'User joined room', {
      connectionId,
      roomId,
      userCount,
      ip: req.socket.remoteAddress
    });

    // Send welcome message to new user
    this.sendToClient(ws, {
      type: 'connected',
      connectionId: connectionId,
      roomId: roomId,
      userCount: userCount
    });

    // Notify other users in room about new user
    this.broadcastToRoom(roomId, {
      type: 'user-joined',
      connectionId: connectionId,
      userCount: userCount
    }, ws);

    // Setup event handlers
    ws.on('message', (data) => {
      this.handleMessage(ws, data);
    });

    ws.on('close', (code, reason) => {
      this.log('debug', 'Connection closed', {
        connectionId,
        roomId,
        code,
        reason: reason.toString()
      });
      this.handleDisconnection(ws);
    });

    ws.on('error', (error) => {
      this.log('error', 'WebSocket error', {
        connectionId,
        roomId,
        error: error.message
      });
      this.handleDisconnection(ws);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });
  }

  /**
   * Handle incoming message from client
   * Validates format, checks rate limit, broadcasts to room
   */
  handleMessage(ws, data) {
    try {
      // Check rate limit before processing
      if (!this.checkRateLimit(ws.connectionId)) {
        this.stats.rateLimitsHit++;

        this.log('warn', 'Rate limit exceeded', {
          connectionId: ws.connectionId,
          roomId: ws.roomId
        });

        this.sendToClient(ws, {
          type: 'error',
          message: 'Rate limit exceeded (100 messages/second)',
          code: 'RATE_LIMIT_EXCEEDED'
        });
        return;
      }

      // Parse and validate message
      const message = JSON.parse(data);

      if (!message.type) {
        this.log('warn', 'Invalid message - missing type', {
          connectionId: ws.connectionId,
          roomId: ws.roomId
        });

        this.sendToClient(ws, {
          type: 'error',
          message: 'Message must have a type field',
          code: 'INVALID_MESSAGE'
        });
        return;
      }

      // Add metadata to message
      message.connectionId = ws.connectionId;
      message.timestamp = Date.now();

      // Log message (debug level to avoid spam)
      this.log('debug', 'Message received', {
        connectionId: ws.connectionId,
        roomId: ws.roomId,
        messageType: message.type
      });

      // Broadcast to all other users in room
      this.broadcastToRoom(ws.roomId, message, ws);
      this.stats.messagesRelayed++;

    } catch (error) {
      this.log('error', 'Message handling error', {
        connectionId: ws.connectionId,
        roomId: ws.roomId,
        error: error.message
      });

      this.sendToClient(ws, {
        type: 'error',
        message: 'Invalid message format - must be valid JSON',
        code: 'PARSE_ERROR'
      });
    }
  }

  /**
   * Handle user disconnection
   * Removes from room, notifies others, cleans up empty rooms
   */
  handleDisconnection(ws) {
    if (!ws.roomId || !ws.connectionId) return;

    const room = this.rooms.get(ws.roomId);
    if (!room) return;

    // Remove connection from room
    room.delete(ws);
    this.stats.disconnectionsTotal++;

    const sessionDuration = Date.now() - ws.joinedAt;

    this.log('info', 'User left room', {
      connectionId: ws.connectionId,
      roomId: ws.roomId,
      remainingUsers: room.size,
      sessionDuration: Math.round(sessionDuration / 1000) + 's'
    });

    // Notify remaining users
    this.broadcastToRoom(ws.roomId, {
      type: 'user-left',
      connectionId: ws.connectionId,
      userCount: room.size
    });

    // Clean up empty room immediately
    if (room.size === 0) {
      this.rooms.delete(ws.roomId);
      this.roomExpiry.delete(ws.roomId);

      this.log('info', 'Room cleaned up (empty)', {
        roomId: ws.roomId
      });
    }

    // Clean up rate limiting tracker
    this.userRates.delete(ws.connectionId);
  }

  /**
   * Send message to a specific client
   */
  sendToClient(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        this.log('error', 'Failed to send message to client', {
          connectionId: ws.connectionId,
          error: error.message
        });
      }
    }
  }

  /**
   * Broadcast message to all users in a room (except sender)
   */
  broadcastToRoom(roomId, message, excludeWs = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    room.forEach(ws => {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(messageStr);
          sentCount++;
        } catch (error) {
          this.log('error', 'Failed to broadcast message', {
            connectionId: ws.connectionId,
            roomId,
            error: error.message
          });
        }
      }
    });

    this.log('debug', 'Broadcast sent', {
      roomId,
      recipientCount: sentCount,
      messageType: message.type
    });
  }

  /**
   * Check if user has exceeded rate limit
   * Uses sliding window counter (resets every second)
   */
  checkRateLimit(connectionId) {
    const now = Date.now();
    const rateData = this.userRates.get(connectionId);

    if (!rateData) return false;

    // Reset counter if window has expired
    if (now > rateData.resetTime) {
      rateData.count = 0;
      rateData.resetTime = now + this.config.rateLimitWindow;
    }

    // Check if limit exceeded
    if (rateData.count >= this.config.rateLimit) {
      return false;
    }

    rateData.count++;
    return true;
  }

  /**
   * Periodic cleanup of expired rooms
   * Runs every hour by default
   */
  startCleanupInterval() {
    this.log('info', 'Starting cleanup interval', {
      intervalMs: this.config.cleanupInterval,
      intervalFormatted: this.formatDuration(this.config.cleanupInterval)
    });

    setInterval(() => {
      const now = Date.now();
      const expiredRooms = [];

      // Find expired rooms
      this.roomExpiry.forEach((expiry, roomId) => {
        if (now > expiry) {
          expiredRooms.push(roomId);
        }
      });

      if (expiredRooms.length === 0) {
        this.log('debug', 'Cleanup check - no expired rooms');
        return;
      }

      this.log('info', 'Cleaning up expired rooms', {
        expiredCount: expiredRooms.length,
        roomIds: expiredRooms
      });

      // Close and remove expired rooms
      expiredRooms.forEach(roomId => {
        const room = this.rooms.get(roomId);
        if (room) {
          // Close all connections in expired room
          room.forEach(ws => {
            this.sendToClient(ws, {
              type: 'room-expired',
              message: 'Room expired after 24 hours'
            });
            ws.close(1000, 'Room expired after 24 hours');
          });

          this.rooms.delete(roomId);
          this.roomExpiry.delete(roomId);

          this.log('info', 'Room expired and cleaned up', {
            roomId,
            userCountAtExpiry: room.size
          });
        }
      });

    }, this.config.cleanupInterval);
  }

  /**
   * Get total number of active connections across all rooms
   */
  getTotalConnections() {
    let total = 0;
    this.rooms.forEach(room => {
      total += room.size;
    });
    return total;
  }

  /**
   * Format uptime in human-readable format
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Format duration in human-readable format
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * Graceful shutdown - close all connections and cleanup
   */
  shutdown() {
    this.log('info', 'Shutting down gracefully...', {
      activeRooms: this.rooms.size,
      activeConnections: this.getTotalConnections()
    });

    // Close all WebSocket connections
    this.rooms.forEach((room, roomId) => {
      room.forEach(ws => {
        this.sendToClient(ws, {
          type: 'server-shutdown',
          message: 'Server is shutting down'
        });
        ws.close(1001, 'Server shutting down');
      });
    });

    // Close WebSocket server
    this.wss.close(() => {
      this.log('info', 'WebSocket server closed');
    });

    // Close HTTP server
    this.server.close(() => {
      this.log('info', 'HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      this.log('warn', 'Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  }
}

// Start the relay server
const relay = new ImpossibleWriterRelay();

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  relay.shutdown();
});

process.on('SIGINT', () => {
  relay.shutdown();
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  relay.log('error', 'Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  relay.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  relay.log('error', 'Unhandled promise rejection', {
    reason: reason,
    promise: promise
  });
});
