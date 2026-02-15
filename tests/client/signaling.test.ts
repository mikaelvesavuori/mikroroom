import { beforeEach, describe, expect, it, vi } from "vitest";

import { SignalingClient } from "../../src/app/signaling.js";
import type { SignalingMessage } from "../../src/app/types.js";

// Mock WebSocket - Use a proper class mock
class MockWebSocketClass {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = WebSocket.CONNECTING;
  onopen: ((this: WebSocket, ev: Event) => void) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => void) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocket, ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    // Store the instance for test access
    (MockWebSocketClass as unknown as { lastInstance: MockWebSocketClass }).lastInstance = this;
  }
}

// Set up global WebSocket with proper static properties
Object.assign(MockWebSocketClass, {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

globalThis.WebSocket = MockWebSocketClass as unknown as typeof WebSocket;

describe("SignalingClient", () => {
  let client: SignalingClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SignalingClient("ws://localhost:3000/ws");
  });

  function getMockWs(): MockWebSocketClass {
    return (MockWebSocketClass as unknown as { lastInstance: MockWebSocketClass }).lastInstance;
  }

  describe("connect", () => {
    it("should establish WebSocket connection", async () => {
      const connectPromise = client.connect();
      const mockWs = getMockWs();

      // Simulate connection open
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }

      await expect(connectPromise).resolves.toBeUndefined();
    });

    it("should reject on connection error", async () => {
      const connectPromise = client.connect();
      const mockWs = getMockWs();

      if (mockWs.onerror) {
        mockWs.onerror.call(mockWs as unknown as WebSocket, new Event("error"));
      }

      await expect(connectPromise).rejects.toBeDefined();
    });
  });

  describe("message handling", () => {
    it("should receive and dispatch messages", async () => {
      const handler = vi.fn();
      client.onMessage(handler);

      // Connect
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;

      // Simulate incoming message
      const message: SignalingMessage = {
        type: "participant-joined",
        roomId: "test-room",
        participantId: "user-1",
        name: "Test User",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        timestamp: Date.now(),
      };

      if (mockWs.onmessage) {
        mockWs.onmessage.call(
          mockWs as unknown as WebSocket,
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "participant-joined",
          participantId: "user-1",
        }),
      );
    });

    it("should handle invalid JSON gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Connect
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;

      // Simulate invalid message
      if (mockWs.onmessage) {
        mockWs.onmessage.call(
          mockWs as unknown as WebSocket,
          new MessageEvent("message", { data: "invalid json" }),
        );
      }

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("send methods", () => {
    beforeEach(async () => {
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;
    });

    it("should send join message", () => {
      const mockWs = getMockWs();
      client.join("room-123", "Test User");

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"join"'));
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"roomId":"room-123"'));
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"name":"Test User"'));
    });

    it("should send leave message", () => {
      const mockWs = getMockWs();
      client.leave("room-123", "user-1");

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"leave"'));
    });

    it("should send offer message", () => {
      const mockWs = getMockWs();
      client.sendOffer("target-user", "room-123", "user-1", "test-sdp");

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"offer"'));
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"sdp":"test-sdp"'));
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"targetId":"target-user"'));
    });

    it("should send answer message", () => {
      const mockWs = getMockWs();
      client.sendAnswer("target-user", "room-123", "user-1", "test-sdp");

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"answer"'));
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"sdp":"test-sdp"'));
    });

    it("should send ICE candidate message", () => {
      const mockWs = getMockWs();
      const candidate: RTCIceCandidateInit = {
        candidate: "test-candidate",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };

      client.sendIceCandidate("target-user", "room-123", "user-1", candidate);

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ice-candidate"'));
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"candidate":"test-candidate"'),
      );
    });
  });

  describe("disconnect", () => {
    it("should close WebSocket connection", async () => {
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;

      client.disconnect();

      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe("isConnected", () => {
    it("should return true when connected", async () => {
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;

      expect(client.isConnected).toBe(true);
    });
  });

  describe("unsubscribe", () => {
    it("should allow unsubscribing from messages", async () => {
      const handler = vi.fn();
      const unsubscribe = client.onMessage(handler);

      // Connect
      const connectPromise = client.connect();
      const mockWs = getMockWs();
      mockWs.readyState = WebSocket.OPEN;
      if (mockWs.onopen) {
        mockWs.onopen.call(mockWs as unknown as WebSocket, new Event("open"));
      }
      await connectPromise;

      // Unsubscribe
      unsubscribe();

      // Send message
      if (mockWs.onmessage) {
        mockWs.onmessage.call(
          mockWs as unknown as WebSocket,
          new MessageEvent("message", { data: '{"type":"test"}' }),
        );
      }

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
