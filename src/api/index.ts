import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";

import { RoomManager } from "./room-manager.js";
import { SignalingServer } from "./signaling.js";

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const USE_HTTPS = process.env.USE_HTTPS === "true";

const MAX_LATENT_ROOMS = process.env.MAX_LATENT_ROOMS
  ? Number.parseInt(process.env.MAX_LATENT_ROOMS, 10)
  : 10;
const LATENT_ROOM_MAX_AGE_HOURS = process.env.LATENT_ROOM_MAX_AGE_HOURS
  ? Number.parseFloat(process.env.LATENT_ROOM_MAX_AGE_HOURS)
  : 24;

const roomManager = new RoomManager({
  maxLatentRooms: MAX_LATENT_ROOMS,
  latentRoomMaxAgeHours: LATENT_ROOM_MAX_AGE_HOURS,
});
const signalingServer = new SignalingServer(roomManager);

// Connection tracking for rate limiting
const connectionAttempts = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_CONNECTIONS_PER_WINDOW = 10;
const MAX_WEBSOCKET_BUFFER_SIZE = 1024 * 1024; // 1MB max buffer size

class WebSocketConnection extends EventTarget {
  public readyState: number;
  public static CONNECTING = 0;
  public static OPEN = 1;
  public static CLOSING = 2;
  public static CLOSED = 3;

  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    this.readyState = WebSocketConnection.OPEN;

    socket.on("data", (data: Buffer) => {
      // Protect against buffer overflow attacks
      if (this.buffer.length + data.length > MAX_WEBSOCKET_BUFFER_SIZE) {
        console.warn("WebSocket buffer overflow detected, closing connection");
        this.close();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });

    socket.on("close", () => {
      this.readyState = WebSocketConnection.CLOSED;
      this.dispatchEvent(new Event("close"));
    });

    socket.on("error", (error: Error) => {
      this.dispatchEvent(new ErrorEvent("error", { message: error.message }));
    });
  }

  private processBuffer(): void {
    while (this.buffer.length >= 2) {
      const result = this.parseFrame(this.buffer);
      if (result === null) {
        // Not enough data for a complete frame
        break;
      }

      const { message, consumed } = result;

      // Remove consumed bytes from buffer
      this.buffer = this.buffer.subarray(consumed);

      // Dispatch the message if we have one
      if (message !== null) {
        const messageEvent = new CustomEvent("message", { detail: { data: message } });
        Object.defineProperty(messageEvent, "data", { value: message });
        this.dispatchEvent(messageEvent as unknown as MessageEvent);
      }
    }
  }

  private parseFrame(data: Buffer): { message: string | null; consumed: number } | null {
    if (data.length < 2) return null;

    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    let payloadLength = data[1] & 0x7f;
    let offset = 2;

    // Calculate header length
    if (payloadLength === 126) {
      if (data.length < 4) return null;
      payloadLength = data.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (data.length < 10) return null;
      payloadLength = Number(data.readBigUInt64BE(2));
      offset = 10;
    }

    // Add mask key length if masked
    if (masked) {
      offset += 4;
    }

    // Check if we have the complete frame
    const totalLength = offset + payloadLength;
    if (data.length < totalLength) return null;

    // Handle close frame
    if (opcode === 8) {
      this.close();
      return { message: null, consumed: totalLength };
    }

    // Only handle text frames for now
    if (opcode !== 1) {
      return { message: null, consumed: totalLength };
    }

    // Extract payload
    const payload = data.subarray(offset, totalLength);
    if (masked) {
      const mask = data.subarray(offset - 4, offset);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    return { message: payload.toString("utf-8"), consumed: totalLength };
  }

  send(data: string): void {
    if (this.readyState !== WebSocketConnection.OPEN) return;

    const payload = Buffer.from(data, "utf-8");
    let frame: Buffer;

    if (payload.length < 126) {
      frame = Buffer.allocUnsafe(2);
      frame[0] = 0x81;
      frame[1] = payload.length;
    } else if (payload.length < 65536) {
      frame = Buffer.allocUnsafe(4);
      frame[0] = 0x81;
      frame[1] = 126;
      frame.writeUInt16BE(payload.length, 2);
    } else {
      frame = Buffer.allocUnsafe(10);
      frame[0] = 0x81;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    this.socket.write(Buffer.concat([frame, payload]));
  }

  close(): void {
    if (this.readyState === WebSocketConnection.CLOSED) return;
    this.readyState = WebSocketConnection.CLOSING;
    this.socket.end();
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempts = connectionAttempts.get(ip) || [];

  // Remove old attempts outside the window
  const validAttempts = attempts.filter((time) => now - time < RATE_LIMIT_WINDOW);

  if (validAttempts.length >= MAX_CONNECTIONS_PER_WINDOW) {
    return false;
  }

  validAttempts.push(now);
  connectionAttempts.set(ip, validAttempts);
  return true;
}

function handleWebSocketUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
  // Rate limiting
  const ip = req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  const response = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "",
    "",
  ].join("\r\n");

  socket.write(response);

  const ws = new WebSocketConnection(socket);
  signalingServer.handleConnection(ws as unknown as WebSocket);
}

const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "MikroRoom API",
          version: "1.0.0",
          endpoints: {
            health: "/health",
            config: "/config",
            websocket: "/ws",
          },
        }),
      );
    } else if (url.pathname === "/health") {
      const stats = roomManager.getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...stats }));
    } else if (url.pathname === "/config") {
      // Expose ICE server configuration (without credentials)
      const iceServers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

      // Add TURN servers from environment if configured
      const turnUrl = process.env.TURN_SERVER_URL;
      if (
        turnUrl &&
        /^turns?:[^:]+:\d+/.test(turnUrl) &&
        process.env.TURN_SERVER_USERNAME &&
        process.env.TURN_SERVER_CREDENTIAL
      ) {
        iceServers.push({
          urls: turnUrl,
          username: process.env.TURN_SERVER_USERNAME,
          credential: process.env.TURN_SERVER_CREDENTIAL,
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ iceServers }));
    } else if (url.pathname === "/api/rooms" && req.method === "POST") {
      // Rate limiting for room creation
      const ip = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(ip)) {
        console.warn(`Rate limit exceeded for room creation from IP: ${ip}`);
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many requests. Please try again later." }));
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const options = body ? JSON.parse(body) : {};
          const result = roomManager.preCreateRoom({
            roomId: options.roomId,
            password: options.password,
            maxParticipants: options.maxParticipants,
          });

          if (!result) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Cannot create room. Limit reached or room ID already exists.",
              }),
            );
            return;
          }

          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request body" }));
        }
      });
      return;
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  } catch (error) {
    console.error("Request error:", error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
};

function createAppServer() {
  if (USE_HTTPS) {
    const certPath = process.env.SSL_CERT_PATH;
    const keyPath = process.env.SSL_KEY_PATH;
    if (!certPath || !keyPath) {
      console.error("SSL_CERT_PATH and SSL_KEY_PATH must be set when USE_HTTPS=true");
      process.exit(1);
    }
    return createHttpsServer(
      {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      },
      requestHandler,
    );
  }
  return createServer(requestHandler);
}

const server = createAppServer();

// WebSocket upgrade handling
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    handleWebSocketUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const protocol = USE_HTTPS ? "https" : "http";
  console.log(`🎥 MikroRoom server running on ${protocol}://localhost:${PORT}`);
  console.log(`📊 Health check: ${protocol}://localhost:${PORT}/health`);
  console.log(`⚙️  Config endpoint: ${protocol}://localhost:${PORT}/config`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

// Periodic cleanup of rate limit data
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of connectionAttempts.entries()) {
    const validAttempts = attempts.filter((time) => now - time < RATE_LIMIT_WINDOW);
    if (validAttempts.length === 0) {
      connectionAttempts.delete(ip);
    } else {
      connectionAttempts.set(ip, validAttempts);
    }
  }
}, RATE_LIMIT_WINDOW);

// Periodic cleanup of abandoned rooms (every 30 minutes)
const ROOM_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const ROOM_MAX_AGE = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const cleaned = roomManager.cleanupAbandonedRooms(ROOM_MAX_AGE);
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} abandoned rooms`);
  }
}, ROOM_CLEANUP_INTERVAL);
