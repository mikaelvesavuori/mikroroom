import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomManager } from "../../src/api/room-manager.js";
import { SignalingServer } from "../../src/api/signaling.js";
import type { SignalingMessage } from "../../src/api/types.js";

// Mock WebSocket-like interface
interface MockWebSocket {
  readyState: number;
  sentMessages: string[];
  eventListeners: Map<string, Array<(...args: unknown[]) => void>>;
  send: (data: string) => void;
  addEventListener: (event: string, callback: (...args: unknown[]) => void) => void;
  triggerEvent: (event: string, ...args: unknown[]) => void;
}

function createMockWebSocket(): MockWebSocket {
  const ws: MockWebSocket = {
    readyState: 1,
    sentMessages: [],
    eventListeners: new Map(),
    send: vi.fn((data: string) => {
      ws.sentMessages.push(data);
    }),
    addEventListener: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (!ws.eventListeners.has(event)) {
        ws.eventListeners.set(event, []);
      }
      ws.eventListeners.get(event)?.push(callback);
    }),
    triggerEvent: (event: string, ...args: unknown[]) => {
      const listeners = ws.eventListeners.get(event);
      if (listeners) {
        for (const callback of listeners) {
          callback(...args);
        }
      }
    },
  };
  return ws;
}

describe("SignalingServer", () => {
  let roomManager: RoomManager;
  let signalingServer: SignalingServer;

  beforeEach(() => {
    roomManager = new RoomManager({ persistencePath: "/tmp/mikroroom-test-rooms.json" });
    signalingServer = new SignalingServer(roomManager);
  });

  describe("handleConnection", () => {
    it("should set up event listeners on WebSocket", () => {
      const mockWs = createMockWebSocket();

      signalingServer.handleConnection(mockWs as unknown as WebSocket);

      expect(mockWs.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith("close", expect.any(Function));
      expect(mockWs.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });

  describe("join handling", () => {
    it("should add participant on join message", () => {
      const mockWs = createMockWebSocket();
      signalingServer.handleConnection(mockWs as unknown as WebSocket);

      const joinMessage: SignalingMessage = {
        type: "join",
        roomId: "test-room",
        participantId: "",
        name: "Test User",
        isHost: true,
        timestamp: Date.now(),
      };

      mockWs.triggerEvent("message", { data: JSON.stringify(joinMessage) });

      const participants = roomManager.getParticipants("test-room");
      expect(participants).toHaveLength(1);
      expect(participants[0]?.name).toBe("Test User");
    });

    it("should reject join when room is full", () => {
      // Fill the room
      for (let i = 0; i < 8; i++) {
        const ws = createMockWebSocket();
        signalingServer.handleConnection(ws as unknown as WebSocket);
        const joinMessage: SignalingMessage = {
          type: "join",
          roomId: "full-room",
          participantId: "",
          name: `User ${i}`,
          isHost: i === 0, // First user is host
          timestamp: Date.now(),
        };
        ws.triggerEvent("message", { data: JSON.stringify(joinMessage) });
      }

      // Try to join with 9th participant
      const newWs = createMockWebSocket();
      signalingServer.handleConnection(newWs as unknown as WebSocket);
      const joinMessage: SignalingMessage = {
        type: "join",
        roomId: "full-room",
        participantId: "",
        name: "User 9",
        timestamp: Date.now(),
      };
      newWs.triggerEvent("message", { data: JSON.stringify(joinMessage) });

      // Should have sent error message
      const errorMessage = JSON.parse(newWs.sentMessages[0] ?? "{}");
      expect(errorMessage.type).toBe("error");
      expect(errorMessage.message).toBe("Room is full");
    });

    it("should notify existing participants of new joiner", () => {
      const mockWs1 = createMockWebSocket();
      signalingServer.handleConnection(mockWs1 as unknown as WebSocket);

      const joinMessage1: SignalingMessage = {
        type: "join",
        roomId: "test-room",
        participantId: "",
        name: "User 1",
        isHost: true,
        timestamp: Date.now(),
      };
      mockWs1.triggerEvent("message", { data: JSON.stringify(joinMessage1) });

      const mockWs2 = createMockWebSocket();
      signalingServer.handleConnection(mockWs2 as unknown as WebSocket);

      const joinMessage2: SignalingMessage = {
        type: "join",
        roomId: "test-room",
        participantId: "",
        name: "User 2",
        timestamp: Date.now(),
      };
      mockWs2.triggerEvent("message", { data: JSON.stringify(joinMessage2) });

      // First user should have received notification of second user
      // The joining user gets their own join message first, then notifications about others
      const lastMessage = mockWs1.sentMessages[mockWs1.sentMessages.length - 1];
      const notification = JSON.parse(lastMessage ?? "{}");
      expect(notification.type).toBe("participant-joined");
      expect(notification.name).toBe("User 2");
    });
  });

  describe("leave handling", () => {
    it("should remove participant on leave message", () => {
      const mockWs = createMockWebSocket();
      signalingServer.handleConnection(mockWs as unknown as WebSocket);

      // Join
      const joinMessage: SignalingMessage = {
        type: "join",
        roomId: "test-room",
        participantId: "",
        name: "Test User",
        isHost: true,
        timestamp: Date.now(),
      };
      mockWs.triggerEvent("message", { data: JSON.stringify(joinMessage) });

      // Leave
      const leaveMessage: SignalingMessage = {
        type: "leave",
        roomId: "test-room",
        participantId: "",
        timestamp: Date.now(),
      };
      mockWs.triggerEvent("message", { data: JSON.stringify(leaveMessage) });

      expect(roomManager.getParticipants("test-room")).toHaveLength(0);
    });

    it("should notify others when participant leaves", () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();

      signalingServer.handleConnection(mockWs1 as unknown as WebSocket);
      signalingServer.handleConnection(mockWs2 as unknown as WebSocket);

      // Both join
      mockWs1.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "room",
          participantId: "",
          name: "User 1",
          isHost: true,
          timestamp: Date.now(),
        }),
      });
      mockWs2.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "room",
          participantId: "",
          name: "User 2",
          timestamp: Date.now(),
        }),
      });

      // Clear messages
      mockWs1.sentMessages = [];

      // User 2 leaves
      mockWs2.triggerEvent("close");

      // User 1 should receive notification
      const notification = JSON.parse(mockWs1.sentMessages[0] ?? "{}");
      expect(notification.type).toBe("participant-left");
    });
  });

  describe("relay messages", () => {
    it("should relay offer messages to target", () => {
      const mockWs1 = createMockWebSocket();
      const mockWs2 = createMockWebSocket();

      signalingServer.handleConnection(mockWs1 as unknown as WebSocket);
      signalingServer.handleConnection(mockWs2 as unknown as WebSocket);

      // Both join
      mockWs1.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "room",
          participantId: "",
          name: "User 1",
          isHost: true,
          timestamp: Date.now(),
        }),
      });
      mockWs2.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "room",
          participantId: "",
          name: "User 2",
          timestamp: Date.now(),
        }),
      });

      // Get User 2's participant ID from their own join notification
      // When User 2 joined, they received their own participant-joined message
      const user2JoinResponse = JSON.parse(mockWs2.sentMessages[0] ?? "{}");
      const user2Id = user2JoinResponse.participantId;

      // Clear User 2's messages to check for the offer
      mockWs2.sentMessages = [];

      // User 1 sends offer to User 2
      const offerMessage = {
        type: "offer",
        roomId: "room",
        participantId: "",
        targetId: user2Id,
        sdp: "test-sdp",
        timestamp: Date.now(),
      };
      mockWs1.triggerEvent("message", { data: JSON.stringify(offerMessage) });

      // User 2 should receive the offer
      const relayedOffer = JSON.parse(mockWs2.sentMessages[0] ?? "{}");
      expect(relayedOffer.type).toBe("offer");
      expect(relayedOffer.sdp).toBe("test-sdp");
    });

    it("should return error for unknown message type", () => {
      const mockWs = createMockWebSocket();
      signalingServer.handleConnection(mockWs as unknown as WebSocket);

      const invalidMessage = {
        type: "unknown-type",
        roomId: "test",
        participantId: "",
        timestamp: Date.now(),
      };

      mockWs.triggerEvent("message", { data: JSON.stringify(invalidMessage) });

      const errorMessage = JSON.parse(mockWs.sentMessages[0] ?? "{}");
      expect(errorMessage.type).toBe("error");
      expect(errorMessage.message).toBe("Unknown message type");
    });

    it("should handle invalid JSON gracefully", () => {
      const mockWs = createMockWebSocket();
      signalingServer.handleConnection(mockWs as unknown as WebSocket);

      mockWs.triggerEvent("message", { data: "invalid json" });

      const errorMessage = JSON.parse(mockWs.sentMessages[0] ?? "{}");
      expect(errorMessage.type).toBe("error");
      expect(errorMessage.message).toBe("Invalid message format");
    });
  });
});
