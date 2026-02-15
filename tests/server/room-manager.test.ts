import { beforeEach, describe, expect, it } from "vitest";

import { RoomManager } from "../../src/api/room-manager.js";
import type { Participant } from "../../src/api/types.js";

describe("RoomManager", () => {
  let roomManager: RoomManager;

  beforeEach(() => {
    roomManager = new RoomManager({ persistencePath: "/tmp/mikroroom-test-rooms.json" });
  });

  describe("createRoom", () => {
    it("should create a new room", () => {
      const room = roomManager.createRoom("test-room");

      expect(room.id).toBe("test-room");
      expect(room.participants.size).toBe(0);
      expect(room.createdAt).toBeGreaterThan(0);
    });

    it("should replace existing room when creating with same ID", () => {
      const room1 = roomManager.createRoom("test-room");
      const room2 = roomManager.createRoom("test-room");

      // createRoom always creates a new room object
      expect(room1).not.toBe(room2);
      expect(room2.id).toBe("test-room");
    });
  });

  describe("getRoom", () => {
    it("should return undefined for non-existent room", () => {
      const room = roomManager.getRoom("non-existent");
      expect(room).toBeUndefined();
    });

    it("should return existing room", () => {
      roomManager.createRoom("test-room");
      const room = roomManager.getRoom("test-room");

      expect(room).toBeDefined();
      expect(room?.id).toBe("test-room");
    });
  });

  describe("getOrCreateRoom", () => {
    it("should create room if it does not exist", () => {
      const room = roomManager.getOrCreateRoom("new-room");
      expect(room.id).toBe("new-room");
    });

    it("should return existing room if it exists", () => {
      const room1 = roomManager.createRoom("existing-room");
      const room2 = roomManager.getOrCreateRoom("existing-room");

      expect(room1).toBe(room2);
    });
  });

  describe("addParticipant", () => {
    it("should add participant to room", () => {
      const mockSocket = { readyState: 1 } as WebSocket;
      const participant: Participant = {
        id: "participant-1",
        name: "Test User",
        socket: mockSocket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      const added = roomManager.addParticipant("test-room", participant);

      expect(added).toBe(true);
      expect(roomManager.getParticipants("test-room")).toHaveLength(1);
    });

    it("should reject participant when room is full (8 participants)", () => {
      roomManager.createRoom("full-room");

      // Add 8 participants
      for (let i = 0; i < 8; i++) {
        const mockSocket = { readyState: 1 } as WebSocket;
        const participant: Participant = {
          id: `participant-${i}`,
          name: `User ${i}`,
          socket: mockSocket,
          roomId: "full-room",
          isModerator: false,
          isMuted: false,
          isVideoOff: false,
          isHandRaised: false,
          joinedAt: Date.now(),
        };
        roomManager.addParticipant("full-room", participant);
      }

      // Try to add 9th participant
      const mockSocket = { readyState: 1 } as WebSocket;
      const participant: Participant = {
        id: "participant-9",
        name: "User 9",
        socket: mockSocket,
        roomId: "full-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      const added = roomManager.addParticipant("full-room", participant);
      expect(added).toBe(false);
    });
  });

  describe("removeParticipant", () => {
    it("should remove participant from room", () => {
      const mockSocket = { readyState: 1 } as WebSocket;
      const participant: Participant = {
        id: "participant-1",
        name: "Test User",
        socket: mockSocket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("test-room", participant);
      roomManager.removeParticipant("test-room", "participant-1");

      expect(roomManager.getParticipants("test-room")).toHaveLength(0);
    });

    it("should delete room when last participant leaves", () => {
      const mockSocket = { readyState: 1 } as WebSocket;
      const participant: Participant = {
        id: "participant-1",
        name: "Test User",
        socket: mockSocket,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      roomManager.addParticipant("test-room", participant);
      roomManager.removeParticipant("test-room", "participant-1");

      expect(roomManager.getRoom("test-room")).toBeUndefined();
      expect(roomManager.getRoomCount()).toBe(0);
    });
  });

  describe("getParticipants", () => {
    it("should return empty array for non-existent room", () => {
      const participants = roomManager.getParticipants("non-existent");
      expect(participants).toEqual([]);
    });

    it("should return all participants in room", () => {
      const mockSocket1 = { readyState: 1 } as WebSocket;
      const mockSocket2 = { readyState: 1 } as WebSocket;

      roomManager.addParticipant("test-room", {
        id: "p1",
        name: "User 1",
        socket: mockSocket1,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });
      roomManager.addParticipant("test-room", {
        id: "p2",
        name: "User 2",
        socket: mockSocket2,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });

      const participants = roomManager.getParticipants("test-room");
      expect(participants).toHaveLength(2);
      expect(participants.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    });
  });

  describe("getOtherParticipants", () => {
    it("should exclude specified participant", () => {
      const mockSocket1 = { readyState: 1 } as WebSocket;
      const mockSocket2 = { readyState: 1 } as WebSocket;

      roomManager.addParticipant("test-room", {
        id: "p1",
        name: "User 1",
        socket: mockSocket1,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });
      roomManager.addParticipant("test-room", {
        id: "p2",
        name: "User 2",
        socket: mockSocket2,
        roomId: "test-room",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });

      const others = roomManager.getOtherParticipants("test-room", "p1");
      expect(others).toHaveLength(1);
      expect(others[0]?.id).toBe("p2");
    });
  });

  describe("room and participant counts", () => {
    it("should track room count", () => {
      expect(roomManager.getRoomCount()).toBe(0);

      roomManager.createRoom("room-1");
      expect(roomManager.getRoomCount()).toBe(1);

      roomManager.createRoom("room-2");
      expect(roomManager.getRoomCount()).toBe(2);
    });

    it("should track total participants", () => {
      const mockSocket = { readyState: 1 } as WebSocket;

      roomManager.addParticipant("room-1", {
        id: "p1",
        name: "User 1",
        socket: mockSocket,
        roomId: "room-1",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });
      roomManager.addParticipant("room-2", {
        id: "p2",
        name: "User 2",
        socket: mockSocket,
        roomId: "room-2",
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      });

      expect(roomManager.getTotalParticipants()).toBe(2);
    });
  });
});
