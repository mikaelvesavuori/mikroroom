import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PeerConnection } from "../../src/app/types.js";

describe("Client App Integration", () => {
  beforeEach(() => {
    // Reset DOM with all required elements for UIManager
    document.body.innerHTML = `
      <div id="app">
        <div id="landing" class="screen"></div>
        <div id="loading" class="screen hidden"></div>
        <div id="meeting" class="screen hidden"></div>
        <div id="error" class="screen hidden"></div>
        <div id="waiting" class="screen hidden"></div>

        <form id="join-form">
          <input type="text" id="name">
          <input type="text" id="room">
          <input type="password" id="password">
          <input type="checkbox" id="enable-video">
          <input type="checkbox" id="enable-audio">
          <input type="checkbox" id="require-password">
          <button type="submit"></button>
        </form>

        <h2 id="room-title"></h2>
        <span id="participant-count"></span>
        <div class="video-container">
          <button id="video-nav-prev" class="video-nav-btn"></button>
          <div id="video-grid"></div>
          <button id="video-nav-next" class="video-nav-btn"></button>
          <div id="video-pagination"><span id="video-page-indicator"></span></div>
        </div>
        <video id="local-video"></video>
        <span id="local-name"></span>
        <span id="local-muted"></span>
        <span id="local-video-off"></span>
        <span id="local-hand"></span>
        <span id="recording-indicator"></span>
        <span id="lock-indicator"></span>
        <span id="connection-quality"></span>

        <button id="btn-mute"></button>
        <button id="btn-video"></button>
        <button id="btn-screen"></button>
        <button id="btn-leave"></button>
        <button id="btn-chat"></button>
        <button id="btn-hand"></button>
        <button id="btn-record"></button>
        <button id="btn-lock"></button>
        <button id="btn-participants"></button>
        <button id="btn-more"></button>

        <div id="mobile-menu">
          <button id="btn-close-mobile-menu"></button>
          <button id="btn-mobile-chat"></button>
          <button id="btn-mobile-participants"></button>
          <button id="btn-mobile-screen"></button>
          <button id="btn-mobile-record"></button>
          <button id="btn-mobile-lock"></button>
          <button id="btn-mobile-hand"></button>
        </div>

        <div id="chat-panel"></div>
        <div id="chat-messages"></div>
        <input type="text" id="chat-input">
        <button id="btn-send-chat"></button>
        <button id="btn-close-chat"></button>
        <input type="file" id="chat-file-input">

        <div id="participants-panel"></div>
        <div id="participants-list"></div>
        <button id="btn-close-participants"></button>

        <div id="waiting-room-list"></div>
        <button id="btn-admit-all"></button>

        <div id="file-transfer-panel"></div>
        <div id="file-transfer-list"></div>

        <p id="error-message"></p>
        <button id="btn-retry"></button>
      </div>
    `;
  });

  describe("DOM setup", () => {
    it("should have required elements", () => {
      expect(document.getElementById("landing")).not.toBeNull();
      expect(document.getElementById("loading")).not.toBeNull();
      expect(document.getElementById("meeting")).not.toBeNull();
      expect(document.getElementById("error")).not.toBeNull();
      expect(document.getElementById("join-form")).not.toBeNull();
      expect(document.getElementById("video-grid")).not.toBeNull();
    });
  });

  describe("UIManager", () => {
    it("should be able to toggle screens", async () => {
      // Dynamic import to avoid DOM not being ready
      const { UIManager } = await import("../../src/app/ui.js");
      const ui = new UIManager();

      ui.showScreen("meeting");
      expect(document.getElementById("landing")?.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("meeting")?.classList.contains("hidden")).toBe(false);

      ui.showScreen("error");
      expect(document.getElementById("meeting")?.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("error")?.classList.contains("hidden")).toBe(false);
    });

    it("should update participant count", async () => {
      const { UIManager } = await import("../../src/app/ui.js");
      const ui = new UIManager();

      ui.setParticipantCount(5);
      expect(document.getElementById("participant-count")?.textContent).toBe("5");
    });

    it("should add and remove remote videos", async () => {
      const { UIManager } = await import("../../src/app/ui.js");
      const ui = new UIManager();

      const mockPeer: PeerConnection = {
        participantId: "test-user",
        name: "Test User",
        connection: {} as RTCPeerConnection,
        stream: undefined,
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
      };

      ui.addRemoteVideo(mockPeer);
      expect(document.getElementById("video-test-user")).not.toBeNull();

      ui.removeRemoteVideo("test-user");
      expect(document.getElementById("video-test-user")).toBeNull();
    });
  });
});

// Mock WebRTC APIs - Use a proper class
class MockRTCPeerConnection {
  connectionState = "new";
  iceConnectionState = "new";
  ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null = null;
  oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null = null;

  createOffer = vi.fn().mockResolvedValue({ type: "offer" as const, sdp: "test-sdp" });
  createAnswer = vi.fn().mockResolvedValue({ type: "answer" as const, sdp: "test-sdp" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  addTrack = vi.fn(() => ({
    getParameters: vi.fn(() => ({ encodings: [] })),
    setParameters: vi.fn().mockResolvedValue(undefined),
  }));
  getSenders = vi.fn(() => []);
  getTransceivers = vi.fn(() => []);
  close = vi.fn();
}

globalThis.RTCPeerConnection = MockRTCPeerConnection as unknown as typeof RTCPeerConnection;

globalThis.MediaStream = vi.fn(() => ({
  getTracks: vi.fn(() => []),
  getAudioTracks: vi.fn(() => []),
  getVideoTracks: vi.fn(() => []),
  addTrack: vi.fn(),
  removeTrack: vi.fn(),
})) as unknown as typeof MediaStream;

describe("PeerManager", () => {
  let mockSignaling: {
    sendOffer: ReturnType<typeof vi.fn>;
    sendAnswer: ReturnType<typeof vi.fn>;
    sendIceCandidate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSignaling = {
      sendOffer: vi.fn(),
      sendAnswer: vi.fn(),
      sendIceCandidate: vi.fn(),
    };
  });

  it("should create peer connection", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    const connection = await manager.createPeerConnection("user-2", "Test User", true);

    expect(connection).toBeDefined();
  });

  it("should handle offer and create answer", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    await manager.handleOffer("user-2", "Test User", "test-offer-sdp");

    const peer = manager.getPeer("user-2");
    expect(peer).toBeDefined();
  });

  it("should handle answer", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    // Create peer first
    await manager.createPeerConnection("user-2", "Test User", true);

    // Then handle answer
    await manager.handleAnswer("user-2", "test-answer-sdp");

    const peer = manager.getPeer("user-2");
    expect(peer).toBeDefined();
  });

  it("should handle ICE candidate", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    await manager.createPeerConnection("user-2", "Test User", true);

    const candidate: RTCIceCandidateInit = {
      candidate: "test-candidate",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    await manager.handleIceCandidate("user-2", candidate);

    const peer = manager.getPeer("user-2");
    expect(peer).toBeDefined();
  });

  it("should remove peer and close connection", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    await manager.createPeerConnection("user-2", "Test User", true);

    manager.removePeer("user-2");

    expect(manager.getPeer("user-2")).toBeUndefined();
  });

  it("should close all connections", async () => {
    const { PeerManager } = await import("../../src/app/peer-manager.js");

    const manager = new PeerManager(
      mockSignaling as unknown as import("../../src/app/signaling.js").SignalingClient,
      "test-room",
      "user-1",
    );

    await manager.createPeerConnection("user-2", "User 2", true);
    await manager.createPeerConnection("user-3", "User 3", true);

    manager.closeAll();

    expect(manager.getAllPeers()).toHaveLength(0);
  });
});
