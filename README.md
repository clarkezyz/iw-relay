# Impossible Writer Relay

Real-time WebSocket relay service for Impossible Writer collaboration.

## Features

- **Room-based collaboration** - Users join rooms by room ID
- **Real-time message forwarding** - Sub-100ms latency
- **Rate limiting** - 100 messages/second per user
- **Auto-cleanup** - Rooms expire after 24 hours
- **Health monitoring** - `/health` endpoint for status

## API

### WebSocket Connection
```
wss://your-domain.railway.app/room/{roomId}
```

### Message Format
```json
{
  "type": "content|cursor|presence",
  "data": { ... }
}
```

## Deployment

Automatically deploys to Railway from this repository.

## Health Check

```
GET /health
```

Returns server status and connection statistics.