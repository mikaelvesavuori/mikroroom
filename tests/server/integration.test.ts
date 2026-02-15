import { beforeEach, describe, expect, it } from "vitest";

import { RoomManager } from "../../src/api/room-manager.js";
import { SignalingServer } from "../../src/api/signaling.js";
import type { Participant, WaitingParticipant } from "../../src/api/types.js";

// Test helpers
interface MockWebSocket extends WebSocket {
  sentMessages: string[];
  closed: boolean;
  triggerEvent(event: string, ...args: unknown[]): void;
}

class TestWebSocket {
  readyState = 1;
  sentMessages: string[] = [];
  closed = false;
  eventListeners: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.triggerEvent("close");
  }

  addEventListener(event: string, callback: (...args: unknown[]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  triggerEvent(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }
}

describe("RoomManager Integration Tests", () => {
  let roomManager: RoomManager;

  beforeEach(() => {
    roomManager = new RoomManager({ persistencePath: "/tmp/mikroroom-test-rooms.json" });
  });

  describe("Room Creation", () => {
    it("should create a room with default max participants", () => {
      const room = roomManager.createRoom("test-room");

      expect(room.id).toBe("test-room");
      expect(room.maxParticipants).toBe(8);
      expect(room.participants.size).toBe(0);
      expect(room.isLocked).toBe(false);
    });

    it("should create a room with custom config", () => {
      const room = roomManager.createRoom("test-room", {
        password: "secret",
        maxParticipants: 4,
      });

      expect(room.password).toBe("secret");
      expect(room.maxParticipants).toBe(4);
    });

    it("should not create duplicate rooms", () => {
      const room1 = roomManager.createRoom("test-room");
      const room2 = roomManager.getOrCreateRoom("test-room");

      expect(room1).toBe(room2);
    });
  });

  describe("Password Validation", () => {
    it("should validate password for existing room", () => {
      roomManager.createRoom("test-room", { password: "secret" });

      expect(roomManager.validatePassword("test-room", "secret")).toBe(true);
      expect(roomManager.validatePassword("test-room", "wrong")).toBe(false);
    });

    it("should allow any password for non-existent room", () => {
      expect(roomManager.validatePassword("new-room", "anything")).toBe(true);
    });

    it("should allow empty password for room without password", () => {
      roomManager.createRoom("test-room");

      expect(roomManager.validatePassword("test-room", undefined)).toBe(true);
    });
  });

  describe("Participant Management", () => {
    it("should add participant and set as host for first joiner", () => {
      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const participant: Participant = {
        id: "p1",
        name: "Test User",
        socket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      const added = roomManager.addParticipant("test-room", participant);

      expect(added).toBe(true);
      expect(participant.isModerator).toBe(true);
      expect(roomManager.getRoom("test-room")?.hostId).toBe("p1");
    });

    it("should reject participant when room is full", () => {
      roomManager.createRoom("test-room", { maxParticipants: 2 });

      for (let i = 0; i < 2; i++) {
        const socket = new TestWebSocket() as unknown as MockWebSocket;
        const participant: Participant = {
          id: `p${i}`,
          name: `User ${i}`,
          socket,
          roomId: "test-room",
          isModerator: false,
          isMuted: false,
          isVideoOff: false,
          isHandRaised: false,
          joinedAt: Date.now(),
        };
        roomManager.addParticipant("test-room", participant);
      }

      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const participant: Participant = {
        id: "p3",
        name: "User 3",
        socket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      const added = roomManager.addParticipant("test-room", participant);
      expect(added).toBe(false);
    });

    it("should transfer host when host leaves", () => {
      const socket1 = new TestWebSocket() as unknown as MockWebSocket;
      const participant1: Participant = {
        id: "p1",
        name: "Host",
        socket: socket1,
        roomId: "test-room",
        isModerator: true,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };
      roomManager.addParticipant("test-room", participant1);

      const socket2 = new TestWebSocket() as unknown as MockWebSocket;
      const participant2: Participant = {
        id: "p2",
        name: "User",
        socket: socket2,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };
      roomManager.addParticipant("test-room", participant2);

      roomManager.removeParticipant("test-room", "p1");

      expect(roomManager.getRoom("test-room")?.hostId).toBe("p2");
      expect(participant2.isModerator).toBe(true);
    });

    it("should delete room when last participant leaves", () => {
      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const participant: Participant = {
        id: "p1",
        name: "Test User",
        socket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("test-room", participant);
      roomManager.removeParticipant("test-room", "p1");

      expect(roomManager.getRoom("test-room")).toBeUndefined();
      expect(roomManager.getRoomCount()).toBe(0);
    });
  });

  describe("Waiting Room", () => {
    it("should add participant to waiting room", () => {
      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const waitingParticipant: WaitingParticipant = {
        id: "wp1",
        name: "Waiting User",
        socket: socket as unknown as MockWebSocket,
        requestedAt: Date.now(),
      };

      const added = roomManager.addToWaitingRoom("test-room", waitingParticipant);

      expect(added).toBe(true);
      expect(roomManager.getWaitingParticipants("test-room")).toHaveLength(1);
    });

    it("should admit participant from waiting room", () => {
      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const waitingParticipant: WaitingParticipant = {
        id: "wp1",
        name: "Waiting User",
        socket: socket as unknown as MockWebSocket,
        requestedAt: Date.now(),
      };

      roomManager.addToWaitingRoom("test-room", waitingParticipant);
      const admitted = roomManager.admitFromWaitingRoom("test-room", "wp1");

      expect(admitted).toBeDefined();
      expect(admitted?.id).toBe("wp1");
      expect(roomManager.getWaitingParticipants("test-room")).toHaveLength(0);
    });

    it("should reject participant from waiting room", () => {
      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const waitingParticipant: WaitingParticipant = {
        id: "wp1",
        name: "Waiting User",
        socket: socket as unknown as MockWebSocket,
        requestedAt: Date.now(),
      };

      roomManager.addToWaitingRoom("test-room", waitingParticipant);
      const rejected = roomManager.rejectFromWaitingRoom("test-room", "wp1");

      expect(rejected).toBeDefined();
      expect(roomManager.getWaitingParticipants("test-room")).toHaveLength(0);
    });
  });

  describe("Broadcasting", () => {
    it("should broadcast message to all participants except excluded", () => {
      const socket1 = new TestWebSocket() as unknown as MockWebSocket;
      const participant1: Participant = {
        id: "p1",
        name: "User 1",
        socket: socket1,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      const socket2 = new TestWebSocket() as unknown as MockWebSocket;
      const participant2: Participant = {
        id: "p2",
        name: "User 2",
        socket: socket2,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("test-room", participant1);
      roomManager.addParticipant("test-room", participant2);

      roomManager.broadcast("test-room", { type: "test", data: "hello" }, "p1");

      expect(socket1.sentMessages).toHaveLength(0);
      expect(socket2.sentMessages).toHaveLength(1);
      expect(JSON.parse(socket2.sentMessages[0]!)).toEqual({
        type: "test",
        data: "hello",
      });
    });

    it("should send message to specific participant", () => {
      const socket1 = new TestWebSocket() as unknown as MockWebSocket;
      const participant1: Participant = {
        id: "p1",
        name: "User 1",
        socket: socket1,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("test-room", participant1);

      roomManager.sendTo("p1", "test-room", { type: "direct", data: "hi" });

      expect(socket1.sentMessages).toHaveLength(1);
      expect(JSON.parse(socket1.sentMessages[0]!)).toEqual({
        type: "direct",
        data: "hi",
      });
    });
  });

  describe("Room Locking", () => {
    it("should lock and unlock room", () => {
      roomManager.createRoom("test-room");

      expect(roomManager.isRoomLocked("test-room")).toBe(false);

      roomManager.lockRoom("test-room");
      expect(roomManager.isRoomLocked("test-room")).toBe(true);

      roomManager.unlockRoom("test-room");
      expect(roomManager.isRoomLocked("test-room")).toBe(false);
    });
  });

  describe("Statistics", () => {
    it("should track statistics correctly", () => {
      roomManager.createRoom("room1");
      roomManager.createRoom("room2");

      const socket = new TestWebSocket() as unknown as MockWebSocket;
      const participant: Participant = {
        id: "p1",
        name: "Test User",
        socket,
        roomId: "room1",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("room1", participant);

      const stats = roomManager.getStats();

      expect(stats.totalRooms).toBe(2);
      expect(stats.totalParticipants).toBe(1);
      expect(stats.peakParticipants).toBe(1);
      expect(stats.version).toBe("1.0.0");
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("SignalingServer Integration Tests", () => {
  let roomManager: RoomManager;
  let signalingServer: SignalingServer;

  beforeEach(() => {
    roomManager = new RoomManager({ persistencePath: "/tmp/mikroroom-test-rooms.json" });
    signalingServer = new SignalingServer(roomManager);
  });

  describe("Connection Handling", () => {
    it("should handle connection and disconnection", () => {
      const socket = new TestWebSocket();
      signalingServer.handleConnection(socket as unknown as MockWebSocket);

      // Simulate join message
      socket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "Test User",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      expect(roomManager.getParticipants("test-room")).toHaveLength(1);

      // Simulate disconnect
      socket.triggerEvent("close");

      expect(roomManager.getParticipants("test-room")).toHaveLength(0);
    });

    it("should reject join with invalid password", () => {
      roomManager.createRoom("test-room", { password: "secret" });

      const socket = new TestWebSocket();
      signalingServer.handleConnection(socket as unknown as MockWebSocket);

      socket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "Test User",
          password: "wrong",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      expect(roomManager.getParticipants("test-room")).toHaveLength(0);
      expect(socket.sentMessages).toHaveLength(1);
      const response = JSON.parse(socket.sentMessages[0]!);
      expect(response.type).toBe("error");
      expect(response.code).toBe("INVALID_PASSWORD");
    });

    it("should add to waiting room when room is locked", () => {
      roomManager.createRoom("test-room");

      // Add first participant as moderator
      const modSocket = new TestWebSocket();
      signalingServer.handleConnection(modSocket as unknown as MockWebSocket);
      modSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "Moderator",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      // Lock the room
      modSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "room-locked",
          roomId: "test-room",
          participantId: "",
          lockedBy: "",
          timestamp: Date.now(),
        }),
      });

      // Try to join with new user
      const userSocket = new TestWebSocket();
      signalingServer.handleConnection(userSocket as unknown as MockWebSocket);
      userSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "New User",
          timestamp: Date.now(),
        }),
      });

      expect(roomManager.getParticipants("test-room")).toHaveLength(1);
      expect(roomManager.getWaitingParticipants("test-room")).toHaveLength(1);

      // Moderator should receive waiting-room notification
      const messages = modSocket.sentMessages.map((m) => JSON.parse(m));
      const waitingRoomMsg = messages.find((m) => m.type === "waiting-room");
      expect(waitingRoomMsg).toBeDefined();
      expect(waitingRoomMsg.name).toBe("New User");
    });
  });

  describe("Chat", () => {
    it("should broadcast chat messages", () => {
      const socket1 = new TestWebSocket();
      const socket2 = new TestWebSocket();

      signalingServer.handleConnection(socket1 as unknown as MockWebSocket);
      signalingServer.handleConnection(socket2 as unknown as MockWebSocket);

      // Join both users
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 1",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      socket2.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 2",
          timestamp: Date.now(),
        }),
      });

      // Clear join messages
      socket1.sentMessages = [];
      socket2.sentMessages = [];

      // Send chat message
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "chat",
          roomId: "test-room",
          participantId: "",
          text: "Hello everyone!",
          timestamp: Date.now(),
        }),
      });

      // Both users should receive the message (socket1 gets echo, socket2 gets broadcast)
      expect(socket1.sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(socket2.sentMessages.length).toBeGreaterThanOrEqual(1);

      const msg1 = socket1.sentMessages.map((m) => JSON.parse(m)).find((m) => m.type === "chat");
      expect(msg1).toBeDefined();
      expect(msg1!.text).toBe("Hello everyone!");
    });
  });

  describe("Moderator Actions", () => {
    it("should allow moderator to kick participant", () => {
      const modSocket = new TestWebSocket();
      const userSocket = new TestWebSocket();

      signalingServer.handleConnection(modSocket as unknown as MockWebSocket);
      signalingServer.handleConnection(userSocket as unknown as MockWebSocket);

      // Join moderator
      modSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "Moderator",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      // Join user
      userSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User",
          timestamp: Date.now(),
        }),
      });

      expect(roomManager.getParticipants("test-room")).toHaveLength(2);

      // Get user ID from room
      const participants = roomManager.getParticipants("test-room");
      const userParticipant = participants.find((p) => p.name === "User");
      expect(userParticipant).toBeDefined();

      // Kick user
      modSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "moderator-action",
          roomId: "test-room",
          participantId: "",
          targetId: userParticipant!.id,
          action: "kick",
          timestamp: Date.now(),
        }),
      });

      // User should be removed
      expect(roomManager.getParticipants("test-room")).toHaveLength(1);
      expect(userSocket.closed).toBe(true);
    });

    it("should not allow non-moderator to kick", () => {
      const modSocket = new TestWebSocket();
      const socket1 = new TestWebSocket();
      const socket2 = new TestWebSocket();

      signalingServer.handleConnection(modSocket as unknown as MockWebSocket);
      signalingServer.handleConnection(socket1 as unknown as MockWebSocket);
      signalingServer.handleConnection(socket2 as unknown as MockWebSocket);

      // Join moderator first
      modSocket.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "Moderator",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      // Join two regular users
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 1",
          timestamp: Date.now(),
        }),
      });

      socket2.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 2",
          timestamp: Date.now(),
        }),
      });

      // Clear messages from joins
      socket1.sentMessages = [];

      const participants = roomManager.getParticipants("test-room");
      const participant2 = participants.find((p) => p.name === "User 2");
      expect(participant2).toBeDefined();

      // Try to kick (should fail - User 1 is not moderator)
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "moderator-action",
          roomId: "test-room",
          participantId: "",
          targetId: participant2!.id,
          action: "kick",
          timestamp: Date.now(),
        }),
      });

      // All three users should still be in room
      expect(roomManager.getParticipants("test-room")).toHaveLength(3);

      // Error should be sent
      const errorMsg = socket1.sentMessages.find((m) => {
        const parsed = JSON.parse(m);
        return parsed.type === "error";
      });
      expect(errorMsg).toBeDefined();
    });
  });

  describe("WebRTC Signaling", () => {
    it("should relay offer to target participant", () => {
      const socket1 = new TestWebSocket();
      const socket2 = new TestWebSocket();

      signalingServer.handleConnection(socket1 as unknown as MockWebSocket);
      signalingServer.handleConnection(socket2 as unknown as MockWebSocket);

      // Join both users
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 1",
          isHost: true,
          timestamp: Date.now(),
        }),
      });

      socket2.triggerEvent("message", {
        data: JSON.stringify({
          type: "join",
          roomId: "test-room",
          name: "User 2",
          timestamp: Date.now(),
        }),
      });

      const participants = roomManager.getParticipants("test-room");
      const participant2 = participants.find((p) => p.name === "User 2");

      // Clear messages
      socket2.sentMessages = [];

      // Send offer
      socket1.triggerEvent("message", {
        data: JSON.stringify({
          type: "offer",
          roomId: "test-room",
          participantId: "",
          targetId: participant2!.id,
          sdp: "test-sdp-offer",
          timestamp: Date.now(),
        }),
      });

      // User 2 should receive the offer
      expect(socket2.sentMessages).toHaveLength(1);
      const offer = JSON.parse(socket2.sentMessages[0]!);
      expect(offer.type).toBe("offer");
      expect(offer.sdp).toBe("test-sdp-offer");
    });
  });
});
