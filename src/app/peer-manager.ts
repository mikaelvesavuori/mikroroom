import { getConfig } from "./config.js";
import type { SignalingClient } from "./signaling.js";
import type { PeerConnection } from "./types.js";

// Default ICE servers (STUN only) - used if config not loaded yet
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * Sanitize SDP for compatibility with older browsers (iOS 15, etc.)
 * Removes problematic lines that older WebRTC implementations can't parse
 */
function sanitizeSDP(sdp: string): string {
  // Split into lines
  const lines = sdp.split("\r\n");
  const sanitized: string[] = [];

  for (const line of lines) {
    // Remove extmap-allow-mixed which causes issues on iOS 15
    if (line.includes("extmap-allow-mixed")) {
      continue;
    }

    // Keep all other lines
    sanitized.push(line);
  }

  return sanitized.join("\r\n");
}

export type PeerEventType =
  | "stream-added"
  | "stream-removed"
  | "connection-state-change"
  | "quality-change"
  | "quality-updated"
  | "error";

export interface PeerEvent {
  type: PeerEventType;
  participantId: string;
  stream?: MediaStream;
  connectionState?: RTCPeerConnectionState;
  quality?: "good" | "fair" | "poor" | "unknown"; // Connection quality from monitoring
  videoQuality?: "high" | "medium" | "low"; // Simulcast layer selection
  error?: Error;
}

export type PeerEventHandler = (event: PeerEvent) => void;

export class PeerManager {
  private peers: Map<string, PeerConnection> = new Map();
  private eventHandlers: Set<PeerEventHandler> = new Set();
  private localStream: MediaStream | null = null;
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private connectionRecoveryAttempts: Map<string, number> = new Map();
  private readonly maxRecoveryAttempts = 3;
  private qualityMonitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private signaling: SignalingClient,
    private roomId: string,
    private participantId: string,
  ) {
    this.loadIceServers();
  }

  private loadIceServers(): void {
    try {
      const config = getConfig();
      if (config.iceServers && config.iceServers.length > 0) {
        this.iceServers = config.iceServers;
      }
    } catch {
      // Keep using DEFAULT_ICE_SERVERS
    }
  }

  setParticipantId(id: string): void {
    this.participantId = id;
  }

  setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
  }

  onEvent(handler: PeerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private emit(event: PeerEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  async createPeerConnection(
    participantId: string,
    name: string,
    isInitiator: boolean,
  ): Promise<RTCPeerConnection> {
    // Check if connection already exists to prevent duplicates
    const existingPeer = this.peers.get(participantId);
    if (existingPeer) {
      console.warn(
        `[createPeerConnection] Connection already exists for participant ${participantId}, returning existing connection`,
      );
      return existingPeer.connection;
    }

    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    // Add local tracks with simulcast if video
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        if (this.localStream) {
          if (track.kind === "video") {
            // Add video track with simulcast encodings (Safari doesn't support modifying after addTrack)
            // For now, just add the track without simulcast to maintain broad compatibility
            connection.addTrack(track, this.localStream);
          } else {
            connection.addTrack(track, this.localStream);
          }
        }
      });
    }

    // Handle remote stream
    connection.ontrack = (event) => {
      const [stream] = event.streams;
      const peer = this.peers.get(participantId);
      if (peer) {
        peer.stream = stream;
        this.emit({
          type: "stream-added",
          participantId,
          stream,
        });
      }
    };

    // Handle ICE candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(
          participantId,
          this.roomId,
          this.participantId,
          event.candidate.toJSON(),
        );
      }
    };

    // Handle ICE connection state
    connection.oniceconnectionstatechange = () => {
      if (
        connection.iceConnectionState === "failed" ||
        connection.iceConnectionState === "disconnected"
      ) {
        this.attemptConnectionRecovery(participantId, name);
      }
    };

    // Handle connection state changes
    connection.onconnectionstatechange = () => {
      this.emit({
        type: "connection-state-change",
        participantId,
        connectionState: connection.connectionState,
      });

      if (connection.connectionState === "failed") {
        this.attemptConnectionRecovery(participantId, name);
      }
    };

    // Store peer connection
    const peer: PeerConnection = {
      participantId,
      name,
      connection,
      isModerator: false,
      isMuted: false,
      isVideoOff: false,
      isHandRaised: false,
    };
    this.peers.set(participantId, peer);
    this.connectionRecoveryAttempts.set(participantId, 0);

    // Create offer if initiator
    if (isInitiator) {
      await this.createOffer(participantId);
    }

    return connection;
  }

  private async attemptConnectionRecovery(participantId: string, name: string): Promise<void> {
    const attempts = this.connectionRecoveryAttempts.get(participantId) || 0;

    if (attempts >= this.maxRecoveryAttempts) {
      console.error(`Max recovery attempts reached for ${participantId}, removing peer`);
      this.removePeer(participantId);
      return;
    }

    this.connectionRecoveryAttempts.set(participantId, attempts + 1);

    // Close existing connection
    const peer = this.peers.get(participantId);
    if (peer) {
      peer.connection.close();
      this.peers.delete(participantId);
    }

    // Wait a moment then recreate
    // Use lexicographic comparison to decide who should initiate
    const shouldInitiate = this.participantId < participantId;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.createPeerConnection(participantId, name, shouldInitiate);
  }

  private async createOffer(participantId: string): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    try {
      const offer = await peer.connection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      // Sanitize SDP for compatibility with older browsers
      if (offer.sdp) {
        offer.sdp = sanitizeSDP(offer.sdp);
      }

      await peer.connection.setLocalDescription(offer);

      if (offer.sdp) {
        this.signaling.sendOffer(participantId, this.roomId, this.participantId, offer.sdp);
      }
    } catch (error) {
      console.error("Failed to create offer:", error);
      this.emit({
        type: "error",
        participantId,
        error: error instanceof Error ? error : new Error("Failed to create offer"),
      });
    }
  }

  async handleOffer(participantId: string, name: string, sdp: string): Promise<void> {
    let peer = this.peers.get(participantId);

    if (!peer) {
      await this.createPeerConnection(participantId, name, false);
      peer = this.peers.get(participantId);
    }

    if (!peer) return;

    try {
      // Handle offer/offer collision - if we have a local offer pending and we're the "loser",
      // rollback our local description and process their offer
      if (peer.connection.signalingState !== "stable") {
        const shouldRollback = this.participantId > participantId; // Loser rolls back
        if (shouldRollback) {
          await peer.connection.setLocalDescription({ type: "rollback" });
        } else {
          return;
        }
      }

      // Sanitize incoming SDP for compatibility
      const sanitizedSdp = sanitizeSDP(sdp);
      await peer.connection.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: sanitizedSdp }),
      );
      const answer = await peer.connection.createAnswer();

      // Sanitize outgoing answer SDP
      if (answer.sdp) {
        answer.sdp = sanitizeSDP(answer.sdp);
      }

      await peer.connection.setLocalDescription(answer);

      if (answer.sdp) {
        this.signaling.sendAnswer(participantId, this.roomId, this.participantId, answer.sdp);
      }
    } catch (error) {
      console.error("Failed to handle offer:", error);
      this.emit({
        type: "error",
        participantId,
        error: error instanceof Error ? error : new Error("Failed to handle offer"),
      });
    }
  }

  async handleAnswer(participantId: string, sdp: string): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    try {
      // Sanitize incoming SDP for compatibility
      const sanitizedSdp = sanitizeSDP(sdp);
      await peer.connection.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: sanitizedSdp }),
      );
    } catch (error) {
      console.error("Failed to handle answer:", error);
      this.emit({
        type: "error",
        participantId,
        error: error instanceof Error ? error : new Error("Failed to handle answer"),
      });
    }
  }

  async handleIceCandidate(participantId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("Failed to add ICE candidate:", error);
    }
  }

  updatePeerState(participantId: string, updates: Partial<PeerConnection>): void {
    const peer = this.peers.get(participantId);
    if (peer) {
      Object.assign(peer, updates);
    }
  }

  changeVideoQuality(participantId: string, quality: "high" | "medium" | "low"): void {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    const transceiver = peer.connection
      .getTransceivers()
      .find((t) => t.sender.track?.kind === "video");

    if (transceiver) {
      const params = transceiver.sender.getParameters();
      if (params.encodings) {
        // Enable/disable simulcast layers based on quality
        params.encodings.forEach((encoding) => {
          if (encoding.rid === quality) {
            encoding.active = true;
          } else {
            encoding.active = false;
          }
        });
        transceiver.sender.setParameters(params).catch((err) => {
          console.warn("Failed to change video quality:", err);
        });
      }
    }

    this.emit({
      type: "quality-change",
      participantId,
      videoQuality: quality,
    });
  }

  async getConnectionQuality(participantId: string): Promise<"good" | "fair" | "poor" | "unknown"> {
    const peer = this.peers.get(participantId);
    if (!peer) return "unknown";

    try {
      const stats = await peer.connection.getStats();
      let inboundStats: RTCInboundRtpStreamStats | null = null;
      let candidateStats: RTCIceCandidatePairStats | null = null;

      // Parse stats report
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          inboundStats = report as RTCInboundRtpStreamStats;
        }
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          candidateStats = report as RTCIceCandidatePairStats;
        }
      });

      // Calculate metrics
      if (inboundStats && candidateStats) {
        // @ts-expect-error
        const packetsLost = inboundStats.packetsLost ?? 0;
        // @ts-expect-error
        const packetsReceived = inboundStats.packetsReceived ?? 0;
        const packetLossRate = packetsReceived > 0 ? packetsLost / packetsReceived : 0;
        // @ts-expect-error
        const rtt = candidateStats.currentRoundTripTime ?? 0;

        // Quality thresholds
        if (packetLossRate > 0.1 || rtt > 0.5) return "poor"; // >10% loss or >500ms RTT
        if (packetLossRate > 0.05 || rtt > 0.25) return "fair"; // >5% loss or >250ms RTT
        return "good";
      }

      // Fallback to connection state if no stats available
      switch (peer.connection.connectionState) {
        case "connected":
          return "good";
        case "connecting":
          return "fair";
        case "disconnected":
        case "failed":
          return "poor";
        default:
          return "unknown";
      }
    } catch (error) {
      console.error(`[Quality] Error getting stats for ${participantId}:`, error);
      return "unknown";
    }
  }

  startQualityMonitoring(): void {
    if (this.qualityMonitorInterval) return;

    this.qualityMonitorInterval = setInterval(() => {
      void (async () => {
        // Check quality of all peers
        for (const [participantId] of this.peers.entries()) {
          const quality = await this.getConnectionQuality(participantId);

          // Emit event for quality updates
          this.emit({
            type: "quality-updated",
            participantId,
            quality,
          });
        }
      })();
    }, 3000); // Check every 3 seconds
  }

  stopQualityMonitoring(): void {
    if (this.qualityMonitorInterval) {
      clearInterval(this.qualityMonitorInterval);
      this.qualityMonitorInterval = null;
    }
  }

  disableIncomingVideos(): void {
    for (const peer of this.peers.values()) {
      const transceiver = peer.connection
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === "video");

      if (transceiver?.receiver.track) {
        transceiver.receiver.track.enabled = false;
      }
    }
  }

  enableIncomingVideos(): void {
    for (const peer of this.peers.values()) {
      const transceiver = peer.connection
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === "video");

      if (transceiver?.receiver.track) {
        transceiver.receiver.track.enabled = true;
      }
    }
  }

  mutePeer(participantId: string): void {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    const senders = peer.connection.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === "audio") {
        sender.track.enabled = false;
      }
    }
  }

  unmutePeer(participantId: string): void {
    const peer = this.peers.get(participantId);
    if (!peer) return;

    const senders = peer.connection.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === "audio") {
        sender.track.enabled = true;
      }
    }
  }

  removePeer(participantId: string): void {
    const peer = this.peers.get(participantId);
    if (peer) {
      peer.connection.close();
      this.peers.delete(participantId);
      this.connectionRecoveryAttempts.delete(participantId);
      this.emit({
        type: "stream-removed",
        participantId,
      });
    }
  }

  getPeer(participantId: string): PeerConnection | undefined {
    return this.peers.get(participantId);
  }

  getAllPeers(): PeerConnection[] {
    return Array.from(this.peers.values());
  }

  closeAll(): void {
    for (const peer of this.peers.values()) {
      peer.connection.close();
    }
    this.peers.clear();
    this.connectionRecoveryAttempts.clear();
  }
}
