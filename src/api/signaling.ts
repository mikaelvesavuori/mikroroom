import { randomUUID } from "node:crypto";

import type { RoomManager } from "./room-manager.js";
import type {
  AdmitUserMessage,
  ChatMessage,
  ErrorMessage,
  JoinMessage,
  LowerHandMessage,
  ModeratorActionMessage,
  Participant,
  ParticipantJoinedMessage,
  ParticipantLeftMessage,
  ParticipantUpdatedMessage,
  RaiseHandMessage,
  RejectUserMessage,
  RoomLockedMessage,
  RoomUnlockedMessage,
  SignalingMessage,
  WaitingParticipant,
  WaitingRoomMessage,
} from "./types.js";

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close?(): void;
  addEventListener(event: "message", callback: (event: { data: string }) => void): void;
  addEventListener(event: "close", callback: () => void): void;
  addEventListener(event: "error", callback: (error: Error) => void): void;
}

export class SignalingServer {
  private participants: Map<WebSocketLike, Participant> = new Map();
  private waitingParticipants: Map<WebSocketLike, WaitingParticipant> = new Map();

  constructor(private roomManager: RoomManager) {}

  handleConnection(socket: WebSocketLike): void {
    socket.addEventListener("message", (event) => {
      this.handleMessage(socket, event.data);
    });

    socket.addEventListener("close", () => {
      this.handleDisconnect(socket);
    });

    socket.addEventListener("error", (error: Error) => {
      console.error("WebSocket error:", error);
      this.handleDisconnect(socket);
    });
  }

  private handleMessage(socket: WebSocketLike, data: string): void {
    try {
      const message = JSON.parse(data) as SignalingMessage;

      switch (message.type) {
        case "join":
          this.handleJoin(socket, message as JoinMessage);
          break;
        case "leave":
          this.handleLeave(socket);
          break;
        case "offer":
        case "answer":
        case "ice-candidate":
        case "file-offer":
        case "file-answer":
        case "file-chunk":
        case "quality-change":
          this.handleRelayMessage(socket, message);
          break;
        case "chat":
          this.handleChat(socket, message as ChatMessage);
          break;
        case "participant-updated":
          this.handleParticipantUpdate(socket, message);
          break;
        case "raise-hand":
          this.handleRaiseHand(socket);
          break;
        case "lower-hand":
          this.handleLowerHand(socket);
          break;
        case "moderator-action":
          this.handleModeratorAction(socket, message as ModeratorActionMessage);
          break;
        case "room-locked":
          this.handleRoomLock(socket);
          break;
        case "room-unlocked":
          this.handleRoomUnlock(socket);
          break;
        case "admit-user":
          this.handleAdmitUser(socket, message as AdmitUserMessage);
          break;
        case "reject-user":
          this.handleRejectUser(socket, message as RejectUserMessage);
          break;
        default:
          this.sendError(socket, "Unknown message type");
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
      this.sendError(socket, "Invalid message format");
    }
  }

  private handleJoin(socket: WebSocketLike, message: JoinMessage): void {
    const participantId = randomUUID();

    // Check if room exists
    const existingRoom = this.roomManager.getRoom(message.roomId);

    // If not creating a new room, the room must already exist
    if (!message.isHost && !existingRoom) {
      this.sendError(socket, "Meeting not found. Check the code and try again.", "ROOM_NOT_FOUND");
      return;
    }

    if (existingRoom && !this.roomManager.validatePassword(message.roomId, message.password)) {
      this.sendError(socket, "Invalid room password", "INVALID_PASSWORD");
      return;
    }

    // Check if joiner has a valid creator token (bypass locked room, become host)
    const isCreator =
      !!message.creatorToken &&
      this.roomManager.validateCreatorToken(message.roomId, message.creatorToken);

    // Check if room is locked (creator token holders bypass the waiting room)
    if (this.roomManager.isRoomLocked(message.roomId) && !isCreator) {
      // Add to waiting room
      const waitingParticipant: WaitingParticipant = {
        id: participantId,
        name: message.name,
        socket: socket as unknown as WebSocket,
        requestedAt: Date.now(),
      };

      if (this.roomManager.addToWaitingRoom(message.roomId, waitingParticipant)) {
        this.waitingParticipants.set(socket, waitingParticipant);

        // Tell the joining user they are in the waiting room
        const waitingAck: WaitingRoomMessage = {
          type: "waiting-room",
          roomId: message.roomId,
          participantId: participantId,
          name: message.name,
          timestamp: Date.now(),
        };
        socket.send(JSON.stringify(waitingAck));

        // Notify moderators
        const waitingMessage: WaitingRoomMessage = {
          type: "waiting-room",
          roomId: message.roomId,
          participantId: participantId,
          name: message.name,
          timestamp: Date.now(),
        };

        const participants = this.roomManager.getParticipants(message.roomId);
        for (const p of participants) {
          if (p.isModerator && p.socket.readyState === 1) {
            p.socket.send(JSON.stringify(waitingMessage));
          }
        }
      } else {
        this.sendError(socket, "Room is full");
      }
      return;
    }

    // Ensure room exists with password if provided
    if (message.password && !existingRoom) {
      this.roomManager.createRoom(message.roomId, { password: message.password });
    }

    const participant: Participant = {
      id: participantId,
      name: message.name,
      socket: socket as unknown as WebSocket,
      roomId: message.roomId,
      isModerator: false,
      isMuted: false,
      isVideoOff: false,
      isHandRaised: false,
      joinedAt: Date.now(),
    };

    const added = this.roomManager.addParticipant(
      message.roomId,
      participant,
      message.isHost || isCreator,
    );

    if (!added) {
      this.sendError(socket, "Room is full");
      return;
    }

    // Creator token holders always become host/moderator;
    // also ensure first participant is always host (handles race conditions)
    const room = this.roomManager.getRoom(message.roomId);
    if (room && (isCreator || room.participants.size === 1)) {
      room.hostId = participant.id;
      participant.isModerator = true;
    }

    this.participants.set(socket, participant);

    // Notify others in the room
    console.log(
      `Server: Sending participant-joined for ${participantId}, isModerator: ${participant.isModerator}`,
    );
    const joinNotification: ParticipantJoinedMessage = {
      type: "participant-joined",
      roomId: message.roomId,
      participantId,
      name: message.name,
      isModerator: participant.isModerator,
      isMuted: participant.isMuted,
      isVideoOff: participant.isVideoOff,
      timestamp: Date.now(),
    };
    this.roomManager.broadcast(message.roomId, joinNotification, participantId);

    // Also send to the joining participant themselves so they know they're the moderator
    socket.send(JSON.stringify(joinNotification));

    // Send existing participants to the new joiner
    const existingParticipants = this.roomManager.getOtherParticipants(
      message.roomId,
      participantId,
    );
    for (const existing of existingParticipants) {
      const existingJoinMessage: ParticipantJoinedMessage = {
        type: "participant-joined",
        roomId: message.roomId,
        participantId: existing.id,
        name: existing.name,
        isModerator: existing.isModerator,
        isMuted: existing.isMuted,
        isVideoOff: existing.isVideoOff,
        timestamp: Date.now(),
      };
      socket.send(JSON.stringify(existingJoinMessage));
    }
  }

  private handleLeave(socket: WebSocketLike): void {
    this.handleDisconnect(socket);
  }

  private handleDisconnect(socket: WebSocketLike): void {
    const participant = this.participants.get(socket);
    const waitingParticipant = this.waitingParticipants.get(socket);

    if (participant) {
      this.roomManager.removeParticipant(participant.roomId, participant.id);
      this.participants.delete(socket);

      const leaveMessage: ParticipantLeftMessage = {
        type: "participant-left",
        roomId: participant.roomId,
        participantId: participant.id,
        timestamp: Date.now(),
      };
      this.roomManager.broadcast(participant.roomId, leaveMessage);
    } else if (waitingParticipant) {
      // BUG FIX: Use roomId from the waiting participant, not socket
      const roomId = this.findRoomForWaitingParticipant(waitingParticipant.id);
      if (roomId) {
        this.roomManager.rejectFromWaitingRoom(roomId, waitingParticipant.id);
      }
      this.waitingParticipants.delete(socket);
    }
  }

  // Helper method to find which room a waiting participant is in
  private findRoomForWaitingParticipant(participantId: string): string | null {
    for (const [roomId, room] of this.roomManager.getRoomIdsAndRooms()) {
      if (room.waitingRoom.has(participantId)) {
        return roomId;
      }
    }
    return null;
  }

  private handleChat(socket: WebSocketLike, message: ChatMessage): void {
    const participant = this.participants.get(socket);
    if (!participant) {
      this.sendError(socket, "Not joined to a room");
      return;
    }

    const chatMessage: ChatMessage = {
      ...message,
      participantId: participant.id,
      timestamp: Date.now(),
    };

    // Broadcast chat to everyone in room (excluding sender)
    this.roomManager.broadcast(participant.roomId, chatMessage, participant.id);
    // Also send to sender
    socket.send(JSON.stringify(chatMessage));
  }

  private handleParticipantUpdate(socket: WebSocketLike, message: ParticipantUpdatedMessage): void {
    const participant = this.participants.get(socket);
    if (!participant) {
      this.sendError(socket, "Not joined to a room");
      return;
    }

    // Update participant state
    if (message.isMuted !== undefined) {
      participant.isMuted = message.isMuted;
    }
    if (message.isVideoOff !== undefined) {
      participant.isVideoOff = message.isVideoOff;
    }
    if (message.isHandRaised !== undefined) {
      participant.isHandRaised = message.isHandRaised;
    }

    // Broadcast update to others
    const updateMessage: ParticipantUpdatedMessage = {
      type: "participant-updated",
      roomId: participant.roomId,
      participantId: participant.id,
      isMuted: participant.isMuted,
      isVideoOff: participant.isVideoOff,
      isHandRaised: participant.isHandRaised,
      timestamp: Date.now(),
    };

    this.roomManager.broadcast(participant.roomId, updateMessage, participant.id);
  }

  private handleRaiseHand(socket: WebSocketLike): void {
    const participant = this.participants.get(socket);
    if (!participant) return;

    participant.isHandRaised = true;

    const message: RaiseHandMessage = {
      type: "raise-hand",
      roomId: participant.roomId,
      participantId: participant.id,
      timestamp: Date.now(),
    };

    this.roomManager.broadcast(participant.roomId, message, participant.id);
  }

  private handleLowerHand(socket: WebSocketLike): void {
    const participant = this.participants.get(socket);
    if (!participant) return;

    participant.isHandRaised = false;

    const message: LowerHandMessage = {
      type: "lower-hand",
      roomId: participant.roomId,
      participantId: participant.id,
      timestamp: Date.now(),
    };

    this.roomManager.broadcast(participant.roomId, message, participant.id);
  }

  private handleModeratorAction(socket: WebSocketLike, message: ModeratorActionMessage): void {
    const participant = this.participants.get(socket);
    if (!participant) {
      this.sendError(socket, "Not joined to a room");
      return;
    }

    // Verify sender is moderator
    if (!participant.isModerator) {
      this.sendError(socket, "Only moderators can perform this action");
      return;
    }

    const targetParticipant = this.roomManager
      .getParticipants(participant.roomId)
      .find((p) => p.id === message.targetId);

    if (!targetParticipant) {
      this.sendError(socket, "Target participant not found");
      return;
    }

    switch (message.action) {
      case "mute":
        this.roomManager.updateParticipant(participant.roomId, message.targetId, { isMuted: true });
        break;
      case "unmute":
        this.roomManager.updateParticipant(participant.roomId, message.targetId, {
          isMuted: false,
        });
        break;
      case "kick":
        // Notify the kicked user before disconnecting them
        this.roomManager.sendTo(message.targetId, participant.roomId, {
          type: "moderator-action",
          roomId: participant.roomId,
          participantId: participant.id,
          targetId: message.targetId,
          action: "kick",
          timestamp: Date.now(),
        });
        // Close the target's socket and remove them after notification
        this.roomManager.kickParticipant(participant.roomId, message.targetId);
        break;
      case "make-moderator":
        this.roomManager.updateParticipant(participant.roomId, message.targetId, {
          isModerator: true,
        });
        break;
    }

    // BUG FIX: Broadcast participant update to all clients so they see the change
    const updateMessage: ParticipantUpdatedMessage = {
      type: "participant-updated",
      roomId: participant.roomId,
      participantId: message.targetId,
      isMuted: targetParticipant.isMuted,
      isHandRaised: targetParticipant.isHandRaised,
      timestamp: Date.now(),
    };
    this.roomManager.broadcast(participant.roomId, updateMessage);

    // Notify target of action
    const actionMessage: ModeratorActionMessage = {
      ...message,
      participantId: participant.id,
      timestamp: Date.now(),
    };

    this.roomManager.sendTo(message.targetId, participant.roomId, actionMessage);
  }

  private handleRoomLock(socket: WebSocketLike): void {
    const participant = this.participants.get(socket);
    if (!participant?.isModerator) {
      this.sendError(socket, "Only moderators can lock the room");
      return;
    }

    this.roomManager.lockRoom(participant.roomId);

    const message: RoomLockedMessage = {
      type: "room-locked",
      roomId: participant.roomId,
      participantId: participant.id,
      lockedBy: participant.id,
      timestamp: Date.now(),
    };

    this.roomManager.broadcast(participant.roomId, message);
  }

  private handleRoomUnlock(socket: WebSocketLike): void {
    const participant = this.participants.get(socket);
    if (!participant?.isModerator) {
      this.sendError(socket, "Only moderators can unlock the room");
      return;
    }

    this.roomManager.unlockRoom(participant.roomId);

    const message: RoomUnlockedMessage = {
      type: "room-unlocked",
      roomId: participant.roomId,
      participantId: participant.id,
      unlockedBy: participant.id,
      timestamp: Date.now(),
    };

    this.roomManager.broadcast(participant.roomId, message);
  }

  private handleAdmitUser(socket: WebSocketLike, message: AdmitUserMessage): void {
    const participant = this.participants.get(socket);
    if (!participant?.isModerator) {
      this.sendError(socket, "Only moderators can admit users");
      return;
    }

    const waitingParticipant = this.roomManager.admitFromWaitingRoom(
      participant.roomId,
      message.targetId,
    );

    if (waitingParticipant) {
      // Convert waiting participant to regular participant
      const newParticipant: Participant = {
        id: waitingParticipant.id,
        name: waitingParticipant.name,
        socket: waitingParticipant.socket,
        roomId: participant.roomId,
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        isHandRaised: false,
        joinedAt: Date.now(),
      };

      this.roomManager.addParticipant(participant.roomId, newParticipant);
      // BUG FIX: Properly cast and store the socket
      const socketKey = waitingParticipant.socket as unknown as WebSocketLike;
      this.participants.set(socketKey, newParticipant);
      this.waitingParticipants.delete(socketKey);

      // Send participant-joined to the admitted user (so they get their ID and show meeting)
      const selfJoinMessage: ParticipantJoinedMessage = {
        type: "participant-joined",
        roomId: participant.roomId,
        participantId: newParticipant.id,
        name: newParticipant.name,
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        timestamp: Date.now(),
      };
      waitingParticipant.socket.send(JSON.stringify(selfJoinMessage));

      // Send existing participants to the newly admitted user
      const existingParticipants = this.roomManager.getOtherParticipants(
        participant.roomId,
        newParticipant.id,
      );
      for (const existing of existingParticipants) {
        const existingJoinMessage: ParticipantJoinedMessage = {
          type: "participant-joined",
          roomId: participant.roomId,
          participantId: existing.id,
          name: existing.name,
          isModerator: existing.isModerator,
          isMuted: existing.isMuted,
          isVideoOff: existing.isVideoOff,
          timestamp: Date.now(),
        };
        waitingParticipant.socket.send(JSON.stringify(existingJoinMessage));
      }

      // Notify others in the room
      const joinNotification: ParticipantJoinedMessage = {
        type: "participant-joined",
        roomId: participant.roomId,
        participantId: newParticipant.id,
        name: newParticipant.name,
        isModerator: false,
        isMuted: false,
        isVideoOff: false,
        timestamp: Date.now(),
      };
      this.roomManager.broadcast(participant.roomId, joinNotification, newParticipant.id);
    }
  }

  private handleRejectUser(socket: WebSocketLike, message: RejectUserMessage): void {
    const participant = this.participants.get(socket);
    if (!participant?.isModerator) {
      this.sendError(socket, "Only moderators can reject users");
      return;
    }

    const waitingParticipant = this.roomManager.rejectFromWaitingRoom(
      participant.roomId,
      message.targetId,
    );

    if (waitingParticipant) {
      const socketKey = waitingParticipant.socket as unknown as WebSocketLike;
      this.waitingParticipants.delete(socketKey);

      // Notify the rejected user
      waitingParticipant.socket.send(
        JSON.stringify({
          type: "reject-user",
          roomId: participant.roomId,
          participantId: waitingParticipant.id,
          reason: message.reason,
          timestamp: Date.now(),
        }),
      );

      // Close their connection
      waitingParticipant.socket.close();
    }
  }

  private handleRelayMessage(socket: WebSocketLike, message: SignalingMessage): void {
    const participant = this.participants.get(socket);
    if (!participant) {
      this.sendError(socket, "Not joined to a room");
      return;
    }

    if ("targetId" in message && message.targetId) {
      this.roomManager.sendTo(message.targetId, participant.roomId, {
        ...message,
        participantId: participant.id,
      });
    }
  }

  private sendError(socket: WebSocketLike, message: string, code?: string): void {
    if (socket.readyState === 1) {
      const errorMessage: ErrorMessage = {
        type: "error",
        roomId: "",
        participantId: "",
        message,
        code,
        timestamp: Date.now(),
      };
      socket.send(JSON.stringify(errorMessage));
    }
  }
}
