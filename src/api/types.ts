export type MessageType =
  | "join"
  | "leave"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "participant-joined"
  | "participant-left"
  | "participant-updated"
  | "chat"
  | "file-offer"
  | "file-answer"
  | "file-chunk"
  | "moderator-action"
  | "room-locked"
  | "room-unlocked"
  | "waiting-room"
  | "admit-user"
  | "reject-user"
  | "raise-hand"
  | "lower-hand"
  | "recording-started"
  | "recording-stopped"
  | "quality-change"
  | "error";

export type ModeratorAction = "mute" | "unmute" | "kick" | "make-moderator";

export interface BaseMessage {
  type: MessageType;
  roomId: string;
  participantId: string;
  timestamp: number;
}

export interface JoinMessage extends BaseMessage {
  type: "join";
  name: string;
  password?: string;
  isHost?: boolean;
  creatorToken?: string;
}

export interface LeaveMessage extends BaseMessage {
  type: "leave";
}

export interface OfferMessage extends BaseMessage {
  type: "offer";
  targetId: string;
  sdp: string;
}

export interface AnswerMessage extends BaseMessage {
  type: "answer";
  targetId: string;
  sdp: string;
}

export interface IceCandidateMessage extends BaseMessage {
  type: "ice-candidate";
  targetId: string;
  candidate: RTCIceCandidateInit;
}

export interface ParticipantJoinedMessage extends BaseMessage {
  type: "participant-joined";
  name: string;
  isModerator: boolean;
  isMuted: boolean;
  isVideoOff: boolean;
}

export interface ParticipantLeftMessage extends BaseMessage {
  type: "participant-left";
}

export interface ParticipantUpdatedMessage extends BaseMessage {
  type: "participant-updated";
  isMuted?: boolean;
  isVideoOff?: boolean;
  isHandRaised?: boolean;
}

export interface ChatMessage extends BaseMessage {
  type: "chat";
  text: string;
  replyTo?: string;
}

export interface FileOfferMessage extends BaseMessage {
  type: "file-offer";
  targetId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

export interface FileAnswerMessage extends BaseMessage {
  type: "file-answer";
  targetId: string;
  accepted: boolean;
}

export interface FileChunkMessage extends BaseMessage {
  type: "file-chunk";
  targetId: string;
  chunk: string;
  index: number;
  total: number;
}

export interface ModeratorActionMessage extends BaseMessage {
  type: "moderator-action";
  targetId: string;
  action: ModeratorAction;
}

export interface RoomLockedMessage extends BaseMessage {
  type: "room-locked";
  lockedBy: string;
}

export interface RoomUnlockedMessage extends BaseMessage {
  type: "room-unlocked";
  unlockedBy: string;
}

export interface WaitingRoomMessage extends BaseMessage {
  type: "waiting-room";
  name: string;
}

export interface AdmitUserMessage extends BaseMessage {
  type: "admit-user";
  targetId: string;
}

export interface RejectUserMessage extends BaseMessage {
  type: "reject-user";
  targetId: string;
  reason: string;
}

export interface RaiseHandMessage extends BaseMessage {
  type: "raise-hand";
}

export interface LowerHandMessage extends BaseMessage {
  type: "lower-hand";
}

export interface RecordingStartedMessage extends BaseMessage {
  type: "recording-started";
  startedBy: string;
}

export interface RecordingStoppedMessage extends BaseMessage {
  type: "recording-stopped";
  stoppedBy: string;
}

export interface QualityChangeMessage extends BaseMessage {
  type: "quality-change";
  targetId: string;
  quality: "high" | "medium" | "low";
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  message: string;
  code?: string;
}

export type SignalingMessage =
  | JoinMessage
  | LeaveMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ParticipantUpdatedMessage
  | ChatMessage
  | FileOfferMessage
  | FileAnswerMessage
  | FileChunkMessage
  | ModeratorActionMessage
  | RoomLockedMessage
  | RoomUnlockedMessage
  | WaitingRoomMessage
  | AdmitUserMessage
  | RejectUserMessage
  | RaiseHandMessage
  | LowerHandMessage
  | RecordingStartedMessage
  | RecordingStoppedMessage
  | QualityChangeMessage
  | ErrorMessage;

export interface Participant {
  id: string;
  name: string;
  socket: WebSocket;
  roomId: string;
  isModerator: boolean;
  isMuted: boolean;
  isVideoOff: boolean;
  isHandRaised: boolean;
  joinedAt: number;
}

export interface WaitingParticipant {
  id: string;
  name: string;
  socket: WebSocket;
  requestedAt: number;
}

export interface Room {
  id: string;
  participants: Map<string, Participant>;
  waitingRoom: Map<string, WaitingParticipant>;
  password?: string;
  isLocked: boolean;
  hostId: string | null;
  createdAt: number;
  maxParticipants: number;
  creatorToken?: string;
  isPreCreated?: boolean;
}

export interface RoomConfig {
  password?: string;
  maxParticipants?: number;
  requireApproval?: boolean;
}

export interface ServerStats {
  totalRooms: number;
  totalParticipants: number;
  peakParticipants: number;
  uptime: number;
  version: string;
}

export interface PreCreatedRoomData {
  roomId: string;
  password?: string;
  creatorToken: string;
  createdAt: number;
  maxParticipants: number;
}
