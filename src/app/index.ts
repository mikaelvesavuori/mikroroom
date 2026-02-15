import { getConfig, loadConfig } from "./config.js";
import { FileTransferManager } from "./file-transfer.js";
import { PeerManager } from "./peer-manager.js";
import { SignalingClient } from "./signaling.js";
import type {
  ChatMessage,
  ChatMessageUI,
  FileAnswerMessage,
  FileChunkMessage,
  FileOfferMessage,
  LowerHandMessage,
  ModeratorActionMessage,
  ParticipantJoinedMessage,
  ParticipantLeftMessage,
  ParticipantUpdatedMessage,
  QualityChangeMessage,
  RaiseHandMessage,
  RejectUserMessage,
  RoomLockedMessage,
  RoomUnlockedMessage,
  SignalingMessage,
  WaitingRoomMessage,
} from "./types.js";
import { UIManager } from "./ui.js";

class MikroRoomApp {
  private ui: UIManager;
  private signaling: SignalingClient | null = null;
  private peerManager: PeerManager | null = null;
  private fileTransferManager: FileTransferManager | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private roomId = "";
  private participantName = "";
  private participantId: string | null = null;
  private isMuted = false;
  private isVideoEnabled = true;
  private isHandRaised = false;
  private isModerator = false;
  private isRoomLocked = false;
  private isRecording = false;
  private chatMessages: ChatMessageUI[] = [];
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isIncomingVideoDisabled = false;
  private isIncomingVideoManuallyDisabled = false;
  private isJoinLinkMode = false;
  private isCreatingRoom = false;

  constructor() {
    this.ui = new UIManager();
    this.setupEventListeners();
    this.loadSavedName();
    this.checkUrlParams();
  }

  private loadSavedName(): void {
    const savedName = localStorage.getItem("MikroRoom-name");
    if (savedName) {
      this.ui.elements.nameInput.value = savedName;
    }
  }

  private saveName(name: string): void {
    localStorage.setItem("MikroRoom-name", name);
  }

  private checkUrlParams(): void {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(window.location.search);

    // Check for ?join=ROOMID parameter (mobile-friendly invite links)
    const joinRoomId = params.get("join");
    if (joinRoomId) {
      this.roomId = joinRoomId; // Set room ID directly
      this.ui.elements.roomInput.value = joinRoomId;
      this.setupJoinLinkUI(joinRoomId);
      // Clean URL to remove join parameter
      window.history.replaceState({}, "", `${window.location.pathname}#${joinRoomId}`);
      return;
    }

    // Fallback to hash-based room ID
    if (hash) {
      this.ui.elements.roomInput.value = hash;
    }

    // Check for creator token in URL (from host link)
    const token = params.get("creatorToken");
    if (token && hash) {
      this.saveCreatorToken(hash, token);
      // Clean the URL to avoid leaking the token
      window.history.replaceState({}, "", `${window.location.pathname}#${hash}`);
    }
  }

  private setupJoinLinkUI(roomId: string): void {
    // Set flag so handleCreateMeeting() and Enter key redirect to handleJoin()
    this.isJoinLinkMode = true;

    // Show initial view with modified UI for joining via link
    this.ui.elements.landingInitial.classList.remove("hidden");
    this.ui.elements.landingJoin.classList.add("hidden");

    // Update subtitle to show room being joined
    const subtitle = document.querySelector(".subtitle");
    if (subtitle) {
      subtitle.textContent = `Joining meeting: ${roomId}`;
    }

    // Change primary button text to "Join Meeting"
    const span = this.ui.elements.btnCreateMeeting.querySelector("span");
    if (span) {
      span.textContent = "Join Meeting";
    }

    // Hide "Join with code" button since we already have the code
    this.ui.elements.btnShowJoin.style.display = "none";
  }

  private setupEventListeners(): void {
    // Landing page navigation
    this.ui.elements.btnCreateMeeting.addEventListener("click", () => this.handleCreateMeeting());
    this.ui.elements.btnShowJoin.addEventListener("click", () => this.showJoinView());
    this.ui.elements.btnBackInitial.addEventListener("click", () => this.showInitialView());
    this.ui.elements.btnShowAdvanced.addEventListener("click", () => this.toggleAdvanced());
    this.ui.elements.btnCopyCreatedLink.addEventListener("click", () => this.copyCreatedLink());
    this.ui.elements.btnJoinCreated.addEventListener("click", () => this.joinCreatedMeeting());

    // Enable/disable landing buttons based on name input
    this.ui.elements.nameInput.addEventListener("input", () => this.updateLandingButtons());
    this.updateLandingButtons(); // Initial state

    // Enter key on name input triggers "New Meeting Room"
    this.ui.elements.nameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !this.ui.elements.btnCreateMeeting.disabled) {
        this.handleCreateMeeting();
      }
    });

    // Join form
    this.ui.elements.joinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleJoin();
    });

    // Auto-extract meeting code from pasted URLs (use paste event to bypass maxlength truncation)
    this.ui.elements.roomInput.addEventListener("paste", (e) => {
      const pasted = e.clipboardData?.getData("text")?.trim();
      if (!pasted) return;

      // Only intercept if pasted text looks like a URL
      if (!pasted.includes("://") && !pasted.includes("#") && !pasted.includes("?join=")) return;

      e.preventDefault();
      let code = "";
      try {
        const url = new URL(pasted);
        // Check for ?join= parameter first
        code = url.searchParams.get("join") || url.hash.slice(1) || "";
      } catch {
        // Fallback: extract code after # or ?join=
        const joinMatch = pasted.match(/[?&]join=([A-Za-z0-9]+)/);
        const hashMatch = pasted.match(/#([A-Za-z0-9]+)/);
        code = joinMatch?.[1] || hashMatch?.[1] || "";
      }

      if (code) {
        this.ui.elements.roomInput.value = code.toUpperCase();
      }
    });

    // Control buttons
    this.ui.elements.btnMute.addEventListener("click", () => this.toggleMute());
    this.ui.elements.btnVideo.addEventListener("click", () => this.toggleVideo());
    this.ui.elements.btnScreen.addEventListener("click", () => this.shareScreen());
    this.ui.elements.btnLeave.addEventListener("click", () => this.leaveMeeting());
    this.ui.elements.btnRetry.addEventListener("click", () => this.ui.showScreen("landing"));

    // Chat
    this.ui.elements.btnChat.addEventListener("click", () => this.ui.toggleChat());
    this.ui.elements.btnCloseChat.addEventListener("click", () => this.ui.closeChat());
    this.ui.elements.btnSendChat.addEventListener("click", () => this.sendChatMessage());
    this.ui.elements.chatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.sendChatMessage();
    });

    // Participants panel
    this.ui.elements.btnParticipants.addEventListener("click", () => this.ui.toggleParticipants());
    this.ui.elements.btnCloseParticipants.addEventListener("click", () =>
      this.ui.closeParticipants(),
    );

    // Participants list actions (delegate)
    this.ui.elements.participantsList.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (action && id) {
        this.handleModeratorAction(action, id);
      }
    });

    // Hand raising
    this.ui.elements.btnHand.addEventListener("click", () => this.toggleHand());

    // Recording
    this.ui.elements.btnRecord.addEventListener("click", () => this.toggleRecording());

    // Room lock
    this.ui.elements.btnLock.addEventListener("click", () => this.toggleRoomLock());

    // Invite button
    this.ui.elements.btnInvite.addEventListener("click", () => this.copyInviteLink());

    // Mobile menu
    this.ui.elements.btnMore.addEventListener("click", () => this.ui.openMobileMenu());
    this.ui.elements.btnMobileChat.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      this.ui.toggleChat();
    });
    this.ui.elements.btnMobileParticipants.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      this.ui.toggleParticipants();
    });
    this.ui.elements.btnMobileScreen.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      void this.shareScreen();
    });
    this.ui.elements.btnMobileRecord.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      this.toggleRecording();
    });
    this.ui.elements.btnMobileLock.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      this.toggleRoomLock();
    });
    this.ui.elements.btnMobileHand.addEventListener("click", () => {
      this.ui.closeMobileMenu();
      this.toggleHand();
    });

    // Window events
    window.addEventListener("beforeunload", () => this.cleanup());
    document.addEventListener("visibilitychange", () => this.handleVisibilityChange());
  }

  private async handleJoin(): Promise<void> {
    const formData = this.ui.getJoinFormData();

    if (!formData.name) {
      alert("Please enter your name");
      return;
    }

    this.participantName = formData.name;
    this.saveName(formData.name);

    // Use room ID from form, or from this.roomId if already set, or generate new
    this.roomId = formData.roomId || this.roomId || this.generateRoomId();

    // Validate room ID format: exactly 6 alphanumeric characters
    if (!/^[A-Z0-9]{6}$/i.test(this.roomId)) {
      alert("Invalid meeting code. Must be exactly 6 characters (letters and numbers only).");
      return;
    }

    // Uppercase for consistency
    this.roomId = this.roomId.toUpperCase();

    this.isVideoEnabled = formData.enableVideo;

    this.ui.showScreen("loading");
    this.ui.setJoinFormDisabled(true);

    try {
      // Load configuration first
      await loadConfig();
      const config = getConfig();

      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: formData.enableVideo
          ? {
              width: { ideal: 1280, max: 1920 },
              height: { ideal: 720, max: 1080 },
              frameRate: { ideal: 30, max: 30 },
              facingMode: "user",
            }
          : false,
        audio: formData.enableAudio
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
      });

      // Use configured WebSocket URL
      this.signaling = new SignalingClient(config.apiUrl);
      await this.signaling.connect();

      this.peerManager = new PeerManager(this.signaling, this.roomId, this.participantId ?? "");
      this.peerManager.setLocalStream(this.localStream);
      this.setupPeerEvents();

      this.fileTransferManager = new FileTransferManager(
        this.signaling,
        this.roomId,
        this.participantId ?? "",
      );
      this.setupFileTransferEvents();

      this.signaling.onMessage((message) => this.handleSignalingMessage(message));

      const storedToken = this.getCreatorToken(this.roomId);
      this.signaling.join(
        this.roomId,
        this.participantName,
        formData.password,
        this.isCreatingRoom,
        storedToken,
      );

      // Note: isModerator is set server-side based on who joins first
      // UI will update when server confirms participant status

      this.ui.setLocalStream(this.localStream);
      this.ui.setLocalName(this.participantName);
      this.ui.setRoomTitle(this.roomId);
      this.ui.setParticipantCount(1);
      this.ui.updateMuteButton(this.isMuted);
      this.ui.updateVideoButton(this.isVideoEnabled);
      this.ui.updateHandButton(this.isHandRaised);
      this.ui.updateRecordButton(this.isRecording);
      this.ui.updateLockButton(this.isRoomLocked);
      // Meeting screen is shown when we receive participant-joined for ourselves
      // If room is locked, we'll get a waiting-room message and show the waiting screen instead

      window.history.replaceState({}, "", `#${this.roomId}`);
    } catch (error) {
      console.error("Failed to join:", error);
      this.ui.showError(this.getErrorMessage(error));
      this.cleanup();
    }
  }

  private handleCreateMeeting(): void {
    // If we arrived via a join link, redirect to handleJoin instead
    if (this.isJoinLinkMode) {
      void this.handleJoin();
      return;
    }

    const name = this.ui.elements.nameInput.value.trim();
    if (!name) {
      alert("Please enter your name");
      return;
    }

    this.participantName = name;
    this.saveName(name);
    this.roomId = this.generateRoomId();
    this.isCreatingRoom = true;

    // Put the room ID in the room input so handleJoin() uses it
    this.ui.elements.roomInput.value = this.roomId;

    // Show the meeting created view with the link (mobile-friendly format)
    const url = `${window.location.origin}${window.location.pathname}?join=${this.roomId}`;
    this.ui.elements.createdLink.value = url;
    this.ui.elements.landingInitial.classList.add("hidden");
    this.ui.elements.landingJoin.classList.add("hidden");
    this.ui.elements.landingAdvanced.classList.add("hidden");
    this.ui.elements.landingCreated.classList.remove("hidden");
  }

  private joinCreatedMeeting(): void {
    // Join the meeting that was just created
    void this.handleJoin();
  }

  private showJoinView(): void {
    this.ui.elements.landingInitial.classList.add("hidden");
    this.ui.elements.landingJoin.classList.remove("hidden");
  }

  private showInitialView(): void {
    this.ui.elements.landingJoin.classList.add("hidden");
    this.ui.elements.landingCreated.classList.add("hidden");
    this.ui.elements.landingInitial.classList.remove("hidden");
  }

  private toggleAdvanced(): void {
    this.ui.elements.landingAdvanced.classList.toggle("hidden");
  }

  private updateLandingButtons(): void {
    const hasName = this.ui.elements.nameInput.value.trim().length > 0;
    this.ui.elements.btnCreateMeeting.disabled = !hasName;
    this.ui.elements.btnShowJoin.disabled = !hasName;
  }

  private copyCreatedLink(): void {
    const link = this.ui.elements.createdLink.value;
    void navigator.clipboard.writeText(link).then(() => {
      const button = this.ui.elements.btnCopyCreatedLink;
      const icon = button.querySelector("use");
      if (icon) icon.setAttribute("href", "#icon-check");

      setTimeout(() => {
        if (icon) icon.setAttribute("href", "#icon-link");
      }, 2000);
    });
  }

  private setupPeerEvents(): void {
    if (!this.peerManager) return;

    // Start continuous quality monitoring
    this.peerManager.startQualityMonitoring();

    this.peerManager.onEvent((event) => {
      switch (event.type) {
        case "stream-added":
          if (event.participantId && event.stream) {
            const peer = this.peerManager?.getPeer(event.participantId);
            if (peer) {
              this.ui.addRemoteVideo(peer);
              this.ui.updateRemoteVideoStream(event.participantId, event.stream);
              this.updateParticipantCount();
              this.updateParticipantsList();
            }
          }
          break;
        case "stream-removed":
          if (event.participantId) {
            this.ui.removeRemoteVideo(event.participantId);
            this.updateParticipantCount();
            this.updateParticipantsList();
          }
          break;
        case "connection-state-change":
          if (event.participantId && event.connectionState) {
            void (async () => {
              const quality = await this.peerManager?.getConnectionQuality(event.participantId);
              if (quality) {
                this.handleNetworkQualityChange(quality);
                this.ui.updateConnectionQuality(quality);
              }
            })();
          }
          break;
        case "quality-updated":
          if (event.participantId && event.quality) {
            this.handleNetworkQualityChange(event.quality);
            this.ui.updateConnectionQuality(event.quality);
          }
          break;
        case "error":
          console.error("Peer error:", event.error);
          break;
      }
    });
  }

  private setupFileTransferEvents(): void {
    if (!this.fileTransferManager) return;

    this.fileTransferManager.onEvent((event) => {
      switch (event.type) {
        case "file-offer-received":
          if (event.transfer) {
            this.ui.addFileTransfer(event.transfer, () => {
              this.fileTransferManager?.rejectFile(event.transferId);
            });
          }
          break;
        case "transfer-started":
          break;
        case "transfer-progress":
          if (event.progress !== undefined) {
            this.ui.updateFileTransferProgress(event.transferId, event.progress);
          }
          break;
        case "transfer-completed":
          this.ui.completeFileTransfer(event.transferId, () => {
            this.fileTransferManager?.downloadFile(event.transferId);
          });
          break;
        case "transfer-cancelled":
        case "transfer-error":
          this.ui.removeFileTransfer(event.transferId);
          break;
      }
    });
  }

  private handleSignalingMessage(message: SignalingMessage): void {
    try {
      switch (message.type) {
        case "participant-joined":
          void this.handleParticipantJoined(message);
          break;
        case "participant-left":
          this.handleParticipantLeft(message);
          break;
        case "participant-updated":
          this.handleParticipantUpdated(message);
          break;
        case "offer":
          void this.handleOffer(message);
          break;
        case "answer":
          void this.handleAnswer(message);
          break;
        case "ice-candidate":
          void this.handleIceCandidate(message);
          break;
        case "chat":
          this.handleChatMessage(message);
          break;
        case "file-offer":
          this.handleFileOffer(message);
          break;
        case "file-answer":
          this.handleFileAnswer(message);
          break;
        case "file-chunk":
          this.handleFileChunk(message);
          break;
        case "moderator-action":
          this.handleModeratorActionMessage(message);
          break;
        case "room-locked":
          this.handleRoomLocked(message);
          break;
        case "room-unlocked":
          this.handleRoomUnlocked(message);
          break;
        case "waiting-room":
          this.handleWaitingRoom(message);
          break;
        case "admit-user":
          this.handleAdmitUser();
          break;
        case "reject-user":
          this.handleRejectUser(message);
          break;
        case "raise-hand":
          this.handleRaiseHand(message);
          break;
        case "lower-hand":
          this.handleLowerHand(message);
          break;
        case "quality-change":
          this.handleQualityChange(message);
          break;
        case "error":
          if (message.code === "INVALID_PASSWORD") {
            this.ui.showError("Invalid room password");
            this.cleanup();
          } else if (message.code === "ROOM_NOT_FOUND") {
            this.ui.showError("Meeting not found. Check the code and try again.");
            this.cleanup();
          }
          break;
      }
    } catch (error) {
      console.error("[handleSignalingMessage] Error handling message:", message.type, error);
    }
  }

  private async handleParticipantJoined(message: ParticipantJoinedMessage): Promise<void> {
    // Initialize our participant ID only once (when we first join)
    if (this.participantId === null) {
      this.participantId = message.participantId;
      this.peerManager?.setParticipantId(message.participantId);
    }

    // Prevent connecting to ourselves
    if (message.participantId === this.participantId) {
      // If we just joined, set moderator flag from server payload
      // Server always sends isModerator, so we should use it directly
      this.isModerator = message.isModerator;
      this.ui.updateModeratorControls(this.isModerator);
      this.ui.showScreen("meeting");
      // Local video srcObject was set while the meeting screen was still hidden,
      // so autoplay may have silently failed. Kick it now that we're visible.
      void this.ui.elements.localVideo.play();
      this.updateParticipantsList();
      return;
    }

    // This is another participant joining, create a peer connection
    // Use lexicographic comparison to deterministically decide who initiates
    const shouldInitiate =
      this.participantId !== null && this.participantId < message.participantId;
    if (this.peerManager) {
      await this.peerManager.createPeerConnection(
        message.participantId,
        message.name,
        shouldInitiate,
      );
      this.peerManager.updatePeerState(message.participantId, {
        isModerator: message.isModerator,
        isMuted: message.isMuted,
        isVideoOff: message.isVideoOff,
      });
      this.ui.updatePeerStatus(message.participantId, {
        isModerator: message.isModerator,
        isMuted: message.isMuted,
        isVideoOff: message.isVideoOff,
      });
    }

    this.updateParticipantsList();
  }

  private handleParticipantLeft(message: ParticipantLeftMessage): void {
    this.peerManager?.removePeer(message.participantId);
    this.updateParticipantCount();
    this.updateParticipantsList();
  }

  private handleParticipantUpdated(message: ParticipantUpdatedMessage): void {
    this.peerManager?.updatePeerState(message.participantId, {
      isMuted: message.isMuted,
      isVideoOff: message.isVideoOff,
      isHandRaised: message.isHandRaised,
    });
    this.ui.updatePeerStatus(message.participantId, {
      isMuted: message.isMuted,
      isHandRaised: message.isHandRaised,
      isVideoOff: message.isVideoOff,
    });
    this.updateParticipantsList();
  }

  private async handleOffer(message: SignalingMessage): Promise<void> {
    if (!("sdp" in message && "targetId" in message)) return;
    const existingPeer = this.peerManager?.getPeer(message.participantId);
    await this.peerManager?.handleOffer(
      message.participantId,
      existingPeer?.name ?? "Participant",
      message.sdp as string,
    );
  }

  private async handleAnswer(message: SignalingMessage): Promise<void> {
    if (!("sdp" in message)) return;
    await this.peerManager?.handleAnswer(message.participantId, message.sdp as string);
  }

  private async handleIceCandidate(message: SignalingMessage): Promise<void> {
    if (!("candidate" in message)) return;
    await this.peerManager?.handleIceCandidate(
      message.participantId,
      message.candidate as RTCIceCandidateInit,
    );
  }

  private handleChatMessage(message: ChatMessage): void {
    const isMe = message.participantId === this.participantId;
    const peer = this.peerManager?.getPeer(message.participantId);

    const chatMessage: ChatMessageUI = {
      id: `${message.timestamp}-${message.participantId}`,
      participantId: message.participantId,
      participantName: isMe ? "You" : peer?.name || "Unknown",
      text: message.text,
      timestamp: message.timestamp,
      isMe,
      replyTo: message.replyTo,
    };

    this.chatMessages.push(chatMessage);
    this.ui.addChatMessage(chatMessage);

    if (!isMe && !this.ui.isChatOpen()) {
      this.ui.showChatUnread();
    }
  }

  private sendChatMessage(): void {
    const text = this.ui.getChatInput();
    if (!text || !this.signaling) return;

    this.signaling.sendChat(this.roomId, this.participantId ?? "", text);
    this.ui.clearChatInput();
  }

  private handleFileOffer(message: FileOfferMessage): void {
    this.fileTransferManager?.handleFileOffer(
      `${message.participantId}-${message.timestamp}`,
      message.participantId,
      "Unknown",
      message.fileName,
      message.fileSize,
      message.fileType,
    );
  }

  private handleFileAnswer(message: FileAnswerMessage): void {
    // Handle file acceptance/rejection
    if (!message.accepted) {
      this.fileTransferManager?.cancelTransfer(`${message.participantId}-${message.timestamp}`);
    }
  }

  private handleFileChunk(message: FileChunkMessage): void {
    this.fileTransferManager?.handleFileChunk(
      `${message.participantId}-${message.timestamp}`,
      message.chunk,
      message.index,
      message.total,
    );
  }

  private handleModeratorActionMessage(message: ModeratorActionMessage): void {
    if (message.targetId !== this.participantId) return;

    switch (message.action) {
      case "mute":
        if (!this.isMuted) this.toggleMute();
        break;
      case "unmute":
        if (this.isMuted) this.toggleMute();
        break;
      case "kick":
        alert("You have been removed from the meeting by a moderator");
        this.leaveMeeting();
        break;
      case "make-moderator":
        this.isModerator = true;
        this.ui.updateModeratorControls(true);
        this.updateParticipantsList();
        alert("You are now a moderator");
        break;
    }
  }

  private handleModeratorAction(action: string, targetId: string): void {
    if (!this.isModerator || !this.signaling) return;

    const validActions = ["mute", "kick", "make-moderator"];
    if (!validActions.includes(action)) return;

    this.signaling.sendModeratorAction(
      targetId,
      this.roomId,
      this.participantId ?? "",
      action as "mute" | "unmute" | "kick" | "make-moderator",
    );
  }

  private handleRoomLocked(_message: RoomLockedMessage): void {
    this.isRoomLocked = true;
    this.ui.updateLockButton(true);
  }

  private handleRoomUnlocked(_message: RoomUnlockedMessage): void {
    this.isRoomLocked = false;
    this.ui.updateLockButton(false);
  }

  private waitingList: Array<{ id: string; name: string }> = [];

  private handleWaitingRoom(message: WaitingRoomMessage): void {
    // If we don't have a participantId yet, this message is telling US we're in the waiting room
    if (this.participantId === null) {
      this.ui.showScreen("waiting");
      return;
    }

    if (!this.isModerator) return;

    // Add to waiting list if not already present
    if (!this.waitingList.some((w) => w.id === message.participantId)) {
      this.waitingList.push({ id: message.participantId, name: message.name });
    }

    // Auto-open participants panel so moderator sees the waiting room
    this.ui.showParticipants();
    this.renderWaitingRoom();
  }

  private renderWaitingRoom(): void {
    this.ui.updateWaitingRoom(
      this.waitingList,
      (id) => {
        this.signaling?.admitUser(id, this.roomId, this.participantId ?? "");
        this.waitingList = this.waitingList.filter((w) => w.id !== id);
        this.renderWaitingRoom();
      },
      (id) => {
        this.signaling?.rejectUser(
          id,
          this.roomId,
          this.participantId ?? "",
          "Rejected by moderator",
        );
        this.waitingList = this.waitingList.filter((w) => w.id !== id);
        this.renderWaitingRoom();
      },
    );
  }

  private handleAdmitUser(): void {
    // Meeting screen will be shown when we receive participant-joined from the server
  }

  private handleRejectUser(message: RejectUserMessage): void {
    this.ui.showError(`Rejected from room: ${message.reason}`);
    this.cleanup();
  }

  private handleRaiseHand(message: RaiseHandMessage): void {
    this.peerManager?.updatePeerState(message.participantId, {
      isHandRaised: true,
    });
    this.ui.updatePeerStatus(message.participantId, { isHandRaised: true });
    this.updateParticipantsList();
  }

  private handleLowerHand(message: LowerHandMessage): void {
    this.peerManager?.updatePeerState(message.participantId, {
      isHandRaised: false,
    });
    this.ui.updatePeerStatus(message.participantId, { isHandRaised: false });
    this.updateParticipantsList();
  }

  private handleQualityChange(message: QualityChangeMessage): void {
    this.peerManager?.changeVideoQuality(message.participantId, message.quality);
  }

  private toggleMute(): void {
    if (!this.localStream) return;

    const audioTracks = this.localStream.getAudioTracks();
    this.isMuted = !this.isMuted;

    for (const track of audioTracks) {
      track.enabled = !this.isMuted;
    }

    this.ui.updateMuteButton(this.isMuted);
    this.signaling?.updateParticipantState(this.roomId, this.participantId ?? "", {
      isMuted: this.isMuted,
    });
  }

  private toggleVideo(): void {
    if (!this.localStream) return;

    const videoTracks = this.localStream.getVideoTracks();
    this.isVideoEnabled = !this.isVideoEnabled;

    for (const track of videoTracks) {
      track.enabled = this.isVideoEnabled;
    }

    this.ui.updateVideoButton(this.isVideoEnabled);
    this.signaling?.updateParticipantState(this.roomId, this.participantId ?? "", {
      isVideoOff: !this.isVideoEnabled,
    });
  }

  private handleNetworkQualityChange(quality: "good" | "fair" | "poor" | "unknown"): void {
    // Auto-disable incoming video on poor quality (if not manually disabled)
    if (
      quality === "poor" &&
      !this.isIncomingVideoDisabled &&
      !this.isIncomingVideoManuallyDisabled
    ) {
      this.isIncomingVideoDisabled = true;
      this.peerManager?.disableIncomingVideos();
      this.ui.updateIncomingVideoButton(true);
    }

    // Auto-re-enable when quality recovers (if not manually disabled)
    if (
      quality === "good" &&
      this.isIncomingVideoDisabled &&
      !this.isIncomingVideoManuallyDisabled
    ) {
      this.isIncomingVideoDisabled = false;
      this.peerManager?.enableIncomingVideos();
      this.ui.updateIncomingVideoButton(false);
    }
  }

  private toggleHand(): void {
    this.isHandRaised = !this.isHandRaised;
    this.ui.updateHandButton(this.isHandRaised);

    if (this.isHandRaised) {
      this.signaling?.raiseHand(this.roomId, this.participantId ?? "");
    } else {
      this.signaling?.lowerHand(this.roomId, this.participantId ?? "");
    }
  }

  private toggleRoomLock(): void {
    if (!this.isModerator) {
      alert("Only moderators can lock/unlock the room");
      return;
    }

    if (this.isRoomLocked) {
      this.signaling?.unlockRoom(this.roomId, this.participantId ?? "");
    } else {
      this.signaling?.lockRoom(this.roomId, this.participantId ?? "");
    }
  }

  private copyInviteLink(): void {
    const url = `${window.location.origin}${window.location.pathname}?join=${this.roomId}`;
    void navigator.clipboard.writeText(url).then(() => {
      const button = this.ui.elements.btnInvite;
      const iconUse = button.querySelector("svg.icon use") as SVGUseElement | null;
      const span = button.querySelector("span");
      const originalHref = iconUse?.getAttribute("href");
      const originalText = span?.textContent;

      // Swap icon to checkmark and flash green
      if (iconUse) iconUse.setAttribute("href", "#icon-check");
      if (span) span.textContent = "Copied!";
      button.classList.add("invite-copied");

      setTimeout(() => {
        if (iconUse && originalHref) iconUse.setAttribute("href", originalHref);
        if (span && originalText) span.textContent = originalText;
        button.classList.remove("invite-copied");
      }, 2000);
    });
  }

  private saveCreatorToken(roomId: string, token: string): void {
    const tokens = this.getStoredTokens();
    tokens[roomId] = token;
    localStorage.setItem("MikroRoom-creator-tokens", JSON.stringify(tokens));
  }

  private getCreatorToken(roomId: string): string | undefined {
    const tokens = this.getStoredTokens();
    return tokens[roomId];
  }

  private getStoredTokens(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem("MikroRoom-creator-tokens") ?? "{}");
    } catch {
      return {};
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isModerator) {
      alert("Only moderators can start/stop recording");
      return;
    }

    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    if (!this.localStream) return;

    try {
      const combinedStream = new MediaStream();

      // If screen sharing, use screen stream instead of camera
      if (this.screenStream) {
        this.screenStream.getTracks().forEach((track) => {
          combinedStream.addTrack(track);
        });
      } else {
        // Otherwise use local camera/mic stream
        this.localStream.getTracks().forEach((track) => {
          combinedStream.addTrack(track);
        });
      }

      // Add all tracks from peer streams
      this.peerManager?.getAllPeers().forEach((peer) => {
        if (peer.stream) {
          peer.stream.getTracks().forEach((track) => {
            combinedStream.addTrack(track);
          });
        }
      });

      this.mediaRecorder = new MediaRecorder(combinedStream);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `MikroRoom-recording-${new Date().toISOString()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.ui.updateRecordButton(true);
    } catch (error) {
      console.error("Failed to start recording:", error);
      alert("Failed to start recording");
    }
  }

  private stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this.ui.updateRecordButton(false);
  }

  private async shareScreen(): Promise<void> {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Store the screen stream for recording purposes
      this.screenStream = screenStream;

      if (this.localStream && this.peerManager) {
        const videoTrack = screenStream.getVideoTracks()[0];
        const senders = this.peerManager
          .getAllPeers()
          .flatMap((peer) => peer.connection.getSenders())
          .filter((s) => s.track?.kind === "video");

        for (const sender of senders) {
          await sender.replaceTrack(videoTrack);
        }

        videoTrack.onended = () => {
          void this.stopScreenShare();
        };
      }
    } catch (error) {
      console.error("Failed to share screen:", error);
    }
  }

  private async stopScreenShare(): Promise<void> {
    try {
      if (!this.localStream) return;

      // Stop and clean up screen stream
      if (this.screenStream) {
        for (const track of this.screenStream.getTracks()) {
          track.stop();
        }
        this.screenStream = null;
      }

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: this.isVideoEnabled
          ? {
              width: { ideal: 1280, max: 1920 },
              height: { ideal: 720, max: 1080 },
              frameRate: { ideal: 30, max: 30 },
              facingMode: "user",
            }
          : false,
        audio: !this.isMuted
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
      });

      const videoTrack = newStream.getVideoTracks()[0] ?? null;

      if (this.peerManager) {
        const senders = this.peerManager
          .getAllPeers()
          .flatMap((peer) => peer.connection.getSenders())
          .filter((s) => s.track?.kind === "video");

        for (const sender of senders) {
          await sender.replaceTrack(videoTrack);
        }
      }

      const oldVideoTrack = this.localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        this.localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }
      if (videoTrack) {
        this.localStream.addTrack(videoTrack);
      }
      this.ui.setLocalStream(this.localStream);
    } catch (error) {
      console.error("Failed to stop screen share:", error);
    }
  }

  private leaveMeeting(): void {
    if (confirm("Leave the meeting?")) {
      this.cleanup();
      this.ui.showScreen("landing");
      this.ui.clearForm();
      this.ui.setJoinFormDisabled(false);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  private cleanup(): void {
    if (this.isRecording) {
      this.stopRecording();
    }

    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        track.stop();
      }
      this.screenStream = null;
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }

    this.peerManager?.stopQualityMonitoring();
    this.peerManager?.closeAll();
    this.peerManager = null;

    this.fileTransferManager = null;

    // Send leave message before disconnecting
    if (this.signaling && this.roomId && this.participantId) {
      this.signaling.leave(this.roomId, this.participantId);
    }
    this.signaling?.disconnect();
    this.signaling = null;

    this.ui.setLocalStream(null);

    // Reset session state
    this.participantId = null;
    this.isMuted = false;
    this.isVideoEnabled = true;
    this.isHandRaised = false;
    this.isModerator = false;
    this.isRoomLocked = false;
    this.isRecording = false;
    this.chatMessages = [];
    this.waitingList = [];
    this.roomId = "";
    this.isCreatingRoom = false;
  }

  private updateParticipantCount(): void {
    const count = 1 + (this.peerManager?.getAllPeers().length ?? 0);
    this.ui.setParticipantCount(count);
  }

  private updateParticipantsList(): void {
    const peers = this.peerManager?.getAllPeers() ?? [];
    const participants = [
      {
        id: this.participantId ?? "local",
        name: this.participantName,
        isModerator: this.isModerator,
        isMuted: this.isMuted,
        isHandRaised: this.isHandRaised,
        isMe: true,
      },
      ...peers.map((peer) => ({
        id: peer.participantId,
        name: peer.name,
        isModerator: peer.isModerator,
        isMuted: peer.isMuted,
        isHandRaised: peer.isHandRaised,
        isMe: false,
      })),
    ];

    this.ui.updateParticipantsList(participants, this.isModerator);
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      this.ui.elements.localVideo.pause();
    } else {
      void this.ui.elements.localVideo.play();
    }
  }

  private generateRoomId(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      if (error.name === "NotAllowedError") {
        return "Camera/microphone access denied. Please check your permissions.";
      }
      if (error.name === "NotFoundError") {
        return "Camera or microphone not found. Please check your devices.";
      }
      return error.message;
    }
    return "An unexpected error occurred. Please try again.";
  }
}

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  new MikroRoomApp();
});
