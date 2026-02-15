import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PeerManager,
  type PeerEvent,
  type PeerEventHandler,
} from "../../src/app/peer-manager.js";
import type { SignalingClient } from "../../src/app/signaling.js";

// Mock WebRTC APIs - Use a proper class
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => void) | null = null;
  onicecandidate:
    | ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => void)
    | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null =
    null;
  oniceconnectionstatechange:
    | ((this: RTCPeerConnection, ev: Event) => void)
    | null = null;

  createOffer = vi.fn().mockResolvedValue({ type: "offer" as const, sdp: "test-sdp-offer" });
  createAnswer = vi.fn().mockResolvedValue({ type: "answer" as const, sdp: "test-sdp-answer" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  addTrack = vi.fn(() => ({
    getParameters: vi.fn(() => ({ encodings: [] })),
    setParameters: vi.fn().mockResolvedValue(undefined),
  }));
  getSenders = vi.fn(() => []);
  getTransceivers = vi.fn(() => []);
  getStats = vi.fn().mockResolvedValue(new Map());
  close = vi.fn();
}

class MockRTCSessionDescription {
  type: RTCSdpType;
  sdp: string;

  constructor(init: { type: RTCSdpType; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;

  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? "";
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }

  toJSON(): RTCIceCandidateInit {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
    };
  }
}

// Mock MediaStream and MediaStreamTrack
class MockMediaStreamTrack {
  kind: "audio" | "video";
  enabled = true;
  id = "track-" + Math.random().toString(36).substring(7);

  constructor(kind: "audio" | "video") {
    this.kind = kind;
  }

  stop = vi.fn();
}

class MockMediaStream {
  id = "stream-" + Math.random().toString(36).substring(7);
  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks: MockMediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }

  getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }

  addTrack(track: MockMediaStreamTrack): void {
    this.tracks.push(track);
  }

  removeTrack(track: MockMediaStreamTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

globalThis.RTCPeerConnection = MockRTCPeerConnection as unknown as typeof RTCPeerConnection;
globalThis.RTCSessionDescription = MockRTCSessionDescription as unknown as typeof RTCSessionDescription;
globalThis.RTCIceCandidate = MockRTCIceCandidate as unknown as typeof RTCIceCandidate;
globalThis.MediaStream = MockMediaStream as unknown as typeof MediaStream;
globalThis.MediaStreamTrack = MockMediaStreamTrack as unknown as typeof MediaStreamTrack;

// Mock SignalingClient
const createMockSignaling = (): SignalingClient =>
  ({
    sendOffer: vi.fn(),
    sendAnswer: vi.fn(),
    sendIceCandidate: vi.fn(),
  }) as unknown as SignalingClient;

// Mock fetch for ICE servers
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("PeerManager", () => {
  let peerManager: PeerManager;
  let mockSignaling: SignalingClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({}),
    });
    mockSignaling = createMockSignaling();
    peerManager = new PeerManager(mockSignaling, "test-room", "user-1");
  });

  describe("constructor", () => {
    it("should initialize with default ICE servers", () => {
      expect(peerManager).toBeDefined();
    });

    it("should use default ICE servers when config not loaded", () => {
      // Create new instance - config not loaded yet in tests
      const manager = new PeerManager(mockSignaling, "test-room", "user-1");

      // Should still work with defaults
      expect(manager).toBeDefined();
    });
  });

  describe("setLocalStream", () => {
    it("should set local stream", () => {
      const mockStream = new MockMediaStream([
        new MockMediaStreamTrack("audio"),
        new MockMediaStreamTrack("video"),
      ]) as unknown as MediaStream;

      peerManager.setLocalStream(mockStream);

      // Create a peer connection to verify stream is used
      expect(async () => {
        await peerManager.createPeerConnection("user-2", "Test User", true);
      }).not.toThrow();
    });
  });

  describe("onEvent", () => {
    it("should register event handler", () => {
      const handler = vi.fn();
      const unsubscribe = peerManager.onEvent(handler);

      expect(unsubscribe).toBeInstanceOf(Function);
    });

    it("should allow unsubscribing from events", () => {
      const handler = vi.fn();
      const unsubscribe = peerManager.onEvent(handler);

      // Unsubscribe
      unsubscribe();

      // Event should not be received
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("createPeerConnection", () => {
    it("should create a new peer connection", async () => {
      const connection = await peerManager.createPeerConnection("user-2", "Test User", true);

      expect(connection).toBeDefined();
      expect(connection).toBeInstanceOf(MockRTCPeerConnection);
    });

    it("should return existing connection if already exists", async () => {
      const connection1 = await peerManager.createPeerConnection("user-2", "Test User", true);
      const connection2 = await peerManager.createPeerConnection("user-2", "Test User", true);

      expect(connection1).toBe(connection2);
    });

    it("should create offer if initiator", async () => {
      await peerManager.createPeerConnection("user-2", "Test User", true);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSignaling.sendOffer).toHaveBeenCalledWith(
        "user-2",
        "test-room",
        "user-1",
        "test-sdp-offer",
      );
    });

    it("should not create offer if not initiator", async () => {
      await peerManager.createPeerConnection("user-2", "Test User", false);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSignaling.sendOffer).not.toHaveBeenCalled();
    });

    it("should add local tracks when creating connection", async () => {
      const mockTrack = new MockMediaStreamTrack("audio");
      const mockStream = new MockMediaStream([mockTrack]) as unknown as MediaStream;

      peerManager.setLocalStream(mockStream);

      const connection = (await peerManager.createPeerConnection("user-2", "Test User", true)) as unknown as MockRTCPeerConnection;

      expect(connection.addTrack).toHaveBeenCalled();
    });

    it("should emit stream-added event when remote track is received", async () => {
      const handler = vi.fn();
      peerManager.onEvent(handler);

      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      // Simulate ontrack event
      const mockStream = new MockMediaStream([new MockMediaStreamTrack("video")]);
      const mockEvent = {
        streams: [mockStream],
        track: mockStream.getTracks()[0],
      } as unknown as RTCTrackEvent;

      const ontrack = connection.ontrack as ((ev: RTCTrackEvent) => void) | null;
      if (ontrack) {
        ontrack(mockEvent);
      }

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stream-added",
          participantId: "user-2",
        }),
      );
    });

    it("should emit connection-state-change event", async () => {
      const handler = vi.fn();
      peerManager.onEvent(handler);

      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      connection.connectionState = "connected";

      const onStateChange = connection.onconnectionstatechange as ((ev: Event) => void) | null;
      if (onStateChange) {
        onStateChange(new Event("statechange"));
      }

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "connection-state-change",
          participantId: "user-2",
          connectionState: "connected",
        }),
      );
    });

    it("should send ICE candidate when one is generated", async () => {
      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      const mockCandidate = new MockRTCIceCandidate({
        candidate: "candidate:test",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      const onIceCandidate = connection.onicecandidate as ((ev: RTCPeerConnectionIceEvent) => void) | null;
      if (onIceCandidate) {
        onIceCandidate({
          candidate: mockCandidate as unknown as RTCIceCandidate,
        } as RTCPeerConnectionIceEvent);
      }

      expect(mockSignaling.sendIceCandidate).toHaveBeenCalledWith(
        "user-2",
        "test-room",
        "user-1",
        expect.any(Object),
      );
    });
  });

  describe("handleOffer", () => {
    it("should handle incoming offer and create answer", async () => {
      await peerManager.handleOffer("user-2", "Test User", "offer-sdp");

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSignaling.sendAnswer).toHaveBeenCalledWith(
        "user-2",
        "test-room",
        "user-1",
        "test-sdp-answer",
      );
    });

    it("should create peer connection if not exists", async () => {
      await peerManager.handleOffer("user-2", "Test User", "offer-sdp");

      const peer = peerManager.getPeer("user-2");
      expect(peer).toBeDefined();
      expect(peer?.name).toBe("Test User");
    });
  });

  describe("handleAnswer", () => {
    it("should handle incoming answer", async () => {
      // First create a connection
      await peerManager.createPeerConnection("user-2", "Test User", true);

      // Then handle the answer
      await peerManager.handleAnswer("user-2", "answer-sdp");

      const peer = peerManager.getPeer("user-2");
      expect(peer?.connection.setRemoteDescription).toHaveBeenCalled();
    });

    it("should not throw if peer does not exist", async () => {
      await expect(
        peerManager.handleAnswer("non-existent", "answer-sdp"),
      ).resolves.not.toThrow();
    });
  });

  describe("handleIceCandidate", () => {
    it("should add ICE candidate to connection", async () => {
      // First create a connection
      await peerManager.createPeerConnection("user-2", "Test User", false);

      const candidate: RTCIceCandidateInit = {
        candidate: "candidate:test",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };

      await peerManager.handleIceCandidate("user-2", candidate);

      const peer = peerManager.getPeer("user-2");
      expect(peer?.connection.addIceCandidate).toHaveBeenCalled();
    });

    it("should not throw if peer does not exist", async () => {
      const candidate: RTCIceCandidateInit = {
        candidate: "candidate:test",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };

      await expect(
        peerManager.handleIceCandidate("non-existent", candidate),
      ).resolves.not.toThrow();
    });
  });

  describe("updatePeerState", () => {
    it("should update peer state properties", async () => {
      await peerManager.createPeerConnection("user-2", "Test User", false);

      peerManager.updatePeerState("user-2", { isMuted: true, isHandRaised: true });

      const peer = peerManager.getPeer("user-2");
      expect(peer?.isMuted).toBe(true);
      expect(peer?.isHandRaised).toBe(true);
    });

    it("should not throw if peer does not exist", () => {
      expect(() => {
        peerManager.updatePeerState("non-existent", { isMuted: true });
      }).not.toThrow();
    });
  });

  describe("changeVideoQuality", () => {
    it("should emit quality-change event", async () => {
      const handler = vi.fn();
      peerManager.onEvent(handler);

      await peerManager.createPeerConnection("user-2", "Test User", false);

      peerManager.changeVideoQuality("user-2", "high");

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "quality-change",
          participantId: "user-2",
          videoQuality: "high",
        }),
      );
    });

    it("should not throw if peer does not exist", () => {
      expect(() => {
        peerManager.changeVideoQuality("non-existent", "low");
      }).not.toThrow();
    });
  });

  describe("getConnectionQuality", () => {
    it("should return connection quality based on connection state", async () => {
      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      connection.connectionState = "connected";
      expect(await peerManager.getConnectionQuality("user-2")).toBe("good");

      connection.connectionState = "connecting";
      expect(await peerManager.getConnectionQuality("user-2")).toBe("fair");

      connection.connectionState = "failed";
      expect(await peerManager.getConnectionQuality("user-2")).toBe("poor");

      connection.connectionState = "disconnected";
      expect(await peerManager.getConnectionQuality("user-2")).toBe("poor");
    });

    it("should return unknown for non-existent peer", async () => {
      expect(await peerManager.getConnectionQuality("non-existent")).toBe("unknown");
    });
  });

  describe("mutePeer / unmutePeer", () => {
    it("should disable audio tracks when muting", async () => {
      const mockTrack = new MockMediaStreamTrack("audio");
      const mockSender = { track: mockTrack };

      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      connection.getSenders = vi.fn().mockReturnValue([mockSender]);

      peerManager.mutePeer("user-2");

      expect(mockTrack.enabled).toBe(false);
    });

    it("should enable audio tracks when unmuting", async () => {
      const mockTrack = new MockMediaStreamTrack("audio");
      mockTrack.enabled = false;
      const mockSender = { track: mockTrack };

      const connection = (await peerManager.createPeerConnection(
        "user-2",
        "Test User",
        false,
      )) as unknown as MockRTCPeerConnection;

      connection.getSenders = vi.fn().mockReturnValue([mockSender]);

      peerManager.unmutePeer("user-2");

      expect(mockTrack.enabled).toBe(true);
    });

    it("should not throw if peer does not exist", () => {
      expect(() => {
        peerManager.mutePeer("non-existent");
        peerManager.unmutePeer("non-existent");
      }).not.toThrow();
    });
  });

  describe("removePeer", () => {
    it("should remove peer and close connection", async () => {
      const handler = vi.fn();
      peerManager.onEvent(handler);

      await peerManager.createPeerConnection("user-2", "Test User", false);

      peerManager.removePeer("user-2");

      expect(peerManager.getPeer("user-2")).toBeUndefined();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stream-removed",
          participantId: "user-2",
        }),
      );
    });

    it("should not throw if peer does not exist", () => {
      expect(() => {
        peerManager.removePeer("non-existent");
      }).not.toThrow();
    });
  });

  describe("getPeer", () => {
    it("should return peer by participant ID", async () => {
      await peerManager.createPeerConnection("user-2", "Test User", false);

      const peer = peerManager.getPeer("user-2");

      expect(peer).toBeDefined();
      expect(peer?.participantId).toBe("user-2");
      expect(peer?.name).toBe("Test User");
    });

    it("should return undefined for non-existent peer", () => {
      expect(peerManager.getPeer("non-existent")).toBeUndefined();
    });
  });

  describe("getAllPeers", () => {
    it("should return all peers", async () => {
      await peerManager.createPeerConnection("user-2", "User 2", false);
      await peerManager.createPeerConnection("user-3", "User 3", false);

      const peers = peerManager.getAllPeers();

      expect(peers).toHaveLength(2);
      expect(peers.map((p) => p.participantId).sort()).toEqual(["user-2", "user-3"]);
    });

    it("should return empty array when no peers", () => {
      expect(peerManager.getAllPeers()).toEqual([]);
    });
  });

  describe("closeAll", () => {
    it("should close all peer connections", async () => {
      const connection1 = (await peerManager.createPeerConnection(
        "user-2",
        "User 2",
        false,
      )) as unknown as MockRTCPeerConnection;
      const connection2 = (await peerManager.createPeerConnection(
        "user-3",
        "User 3",
        false,
      )) as unknown as MockRTCPeerConnection;

      peerManager.closeAll();

      expect(connection1.close).toHaveBeenCalled();
      expect(connection2.close).toHaveBeenCalled();
      expect(peerManager.getAllPeers()).toHaveLength(0);
    });
  });
});
