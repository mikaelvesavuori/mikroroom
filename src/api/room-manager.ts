import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  Participant,
  PreCreatedRoomData,
  Room,
  RoomConfig,
  ServerStats,
  WaitingParticipant,
} from "./types.js";

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private startTime = Date.now();
  private peakParticipants = 0;
  private readonly defaultMaxParticipants = 8;
  private readonly persistencePath: string;
  private readonly maxLatentRooms: number;
  private readonly latentRoomMaxAgeMs: number;

  constructor(options?: {
    persistencePath?: string;
    maxLatentRooms?: number;
    latentRoomMaxAgeHours?: number;
  }) {
    this.persistencePath = options?.persistencePath ?? "data/rooms.json";
    this.maxLatentRooms = options?.maxLatentRooms ?? 10;
    this.latentRoomMaxAgeMs = (options?.latentRoomMaxAgeHours ?? 24) * 60 * 60 * 1000;
    this.loadPreCreatedRooms();
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  createRoom(roomId: string, config?: RoomConfig): Room {
    const room: Room = {
      id: roomId,
      participants: new Map(),
      waitingRoom: new Map(),
      password: config?.password,
      isLocked: false,
      hostId: null,
      createdAt: Date.now(),
      maxParticipants: config?.maxParticipants ?? this.defaultMaxParticipants,
    };
    this.rooms.set(roomId, room);
    return room;
  }

  preCreateRoom(options?: {
    roomId?: string;
    password?: string;
    maxParticipants?: number;
  }): { roomId: string; creatorToken: string } | null {
    // Count existing latent (empty pre-created) rooms
    const latentCount = this.getLatentRoomCount();
    if (latentCount >= this.maxLatentRooms) {
      return null;
    }

    const roomId = options?.roomId ?? this.generateRoomId();
    if (this.rooms.has(roomId)) {
      return null;
    }

    const creatorToken = randomUUID();
    const room: Room = {
      id: roomId,
      participants: new Map(),
      waitingRoom: new Map(),
      password: options?.password,
      isLocked: false,
      hostId: null,
      createdAt: Date.now(),
      maxParticipants: options?.maxParticipants ?? this.defaultMaxParticipants,
      creatorToken,
      isPreCreated: true,
    };

    this.rooms.set(roomId, room);
    this.persistPreCreatedRooms();

    return { roomId, creatorToken };
  }

  validateCreatorToken(roomId: string, token: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room?.creatorToken) return false;
    return room.creatorToken === token;
  }

  private getLatentRoomCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.isPreCreated && room.participants.size === 0) {
        count++;
      }
    }
    return count;
  }

  private generateRoomId(): string {
    return randomUUID().split("-")[0];
  }

  private loadPreCreatedRooms(): void {
    try {
      if (!existsSync(this.persistencePath)) return;
      const data = readFileSync(this.persistencePath, "utf-8");
      const rooms: PreCreatedRoomData[] = JSON.parse(data);

      for (const roomData of rooms) {
        // Skip rooms that have exceeded the latent max age
        if (Date.now() - roomData.createdAt > this.latentRoomMaxAgeMs) continue;

        const room: Room = {
          id: roomData.roomId,
          participants: new Map(),
          waitingRoom: new Map(),
          password: roomData.password,
          isLocked: false,
          hostId: null,
          createdAt: roomData.createdAt,
          maxParticipants: roomData.maxParticipants,
          creatorToken: roomData.creatorToken,
          isPreCreated: true,
        };
        this.rooms.set(roomData.roomId, room);
      }

      console.log(`Loaded ${this.rooms.size} pre-created rooms from disk`);
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  private persistPreCreatedRooms(): void {
    const preCreated: PreCreatedRoomData[] = [];
    for (const room of this.rooms.values()) {
      if (room.isPreCreated && room.creatorToken) {
        preCreated.push({
          roomId: room.id,
          password: room.password,
          creatorToken: room.creatorToken,
          createdAt: room.createdAt,
          maxParticipants: room.maxParticipants,
        });
      }
    }

    try {
      const dir = dirname(this.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistencePath, JSON.stringify(preCreated, null, 2));
    } catch (error) {
      console.error("Failed to persist pre-created rooms:", error);
    }
  }

  getOrCreateRoom(roomId: string, config?: RoomConfig): Room {
    const existing = this.getRoom(roomId);
    if (existing) return existing;
    return this.createRoom(roomId, config);
  }

  validatePassword(roomId: string, password?: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return true; // Room doesn't exist yet, will be created
    if (!room.password) return true; // No password required
    return room.password === password;
  }

  addToWaitingRoom(roomId: string, participant: WaitingParticipant): boolean {
    const room = this.getOrCreateRoom(roomId);
    if (room.participants.size >= room.maxParticipants) {
      return false;
    }
    room.waitingRoom.set(participant.id, participant);
    return true;
  }

  admitFromWaitingRoom(roomId: string, participantId: string): WaitingParticipant | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const participant = room.waitingRoom.get(participantId);
    if (participant) {
      room.waitingRoom.delete(participantId);
    }
    return participant;
  }

  rejectFromWaitingRoom(roomId: string, participantId: string): WaitingParticipant | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const participant = room.waitingRoom.get(participantId);
    if (participant) {
      room.waitingRoom.delete(participantId);
    }
    return participant;
  }

  addParticipant(roomId: string, participant: Participant, isHost = false): boolean {
    const room = this.getOrCreateRoom(roomId);

    if (room.participants.size >= room.maxParticipants) {
      return false;
    }

    // First participant becomes host
    if (room.participants.size === 0 || isHost) {
      room.hostId = participant.id;
      participant.isModerator = true;
    }

    room.participants.set(participant.id, participant);

    // Update peak participants
    const currentTotal = this.getTotalParticipants();
    if (currentTotal > this.peakParticipants) {
      this.peakParticipants = currentTotal;
    }

    return true;
  }

  removeParticipant(roomId: string, participantId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.participants.delete(participantId);

    // If host left, assign new host
    if (room.hostId === participantId && room.participants.size > 0) {
      const newHost = room.participants.values().next().value;
      if (newHost) {
        room.hostId = newHost.id;
        newHost.isModerator = true;
      }
    }

    if (room.participants.size === 0 && !room.isPreCreated) {
      this.rooms.delete(roomId);
    }
  }

  updateParticipant(roomId: string, participantId: string, updates: Partial<Participant>): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(participantId);
    if (participant) {
      Object.assign(participant, updates);
    }
  }

  lockRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.isLocked = true;
    }
  }

  unlockRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.isLocked = false;
    }
  }

  isRoomLocked(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.isLocked ?? false;
  }

  getParticipants(roomId: string): Participant[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.participants.values()) : [];
  }

  getWaitingParticipants(roomId: string): WaitingParticipant[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.waitingRoom.values()) : [];
  }

  getOtherParticipants(roomId: string, excludeId: string): Participant[] {
    return this.getParticipants(roomId).filter((p) => p.id !== excludeId);
  }

  broadcast(roomId: string, message: unknown, excludeId?: string): void {
    const participants = this.getOtherParticipants(roomId, excludeId ?? "");
    const messageStr = JSON.stringify(message);

    for (const participant of participants) {
      if (participant.socket.readyState === 1) {
        participant.socket.send(messageStr);
      }
    }
  }

  sendTo(participantId: string, roomId: string, message: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(participantId);
    if (participant && participant.socket.readyState === 1) {
      participant.socket.send(JSON.stringify(message));
    }
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  getTotalParticipants(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      count += room.participants.size;
    }
    return count;
  }

  getStats(): ServerStats {
    return {
      totalRooms: this.rooms.size,
      totalParticipants: this.getTotalParticipants(),
      peakParticipants: this.peakParticipants,
      uptime: Date.now() - this.startTime,
      version: "1.0.0",
    };
  }

  // Get all room IDs and rooms for iteration
  *getRoomIdsAndRooms(): Generator<[string, Room]> {
    for (const [roomId, room] of this.rooms.entries()) {
      yield [roomId, room];
    }
  }

  // Clean up abandoned rooms (no participants for a while)
  cleanupAbandonedRooms(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let cleanedCount = 0;
    let persistNeeded = false;

    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.size > 0) continue;

      const maxAge = room.isPreCreated ? this.latentRoomMaxAgeMs : maxAgeMs;
      if (now - room.createdAt > maxAge) {
        this.rooms.delete(roomId);
        cleanedCount++;
        if (room.isPreCreated) persistNeeded = true;
        console.log(`Cleaned up abandoned room: ${roomId}`);
      }
    }

    if (persistNeeded) this.persistPreCreatedRooms();
    return cleanedCount;
  }

  isModerator(roomId: string, participantId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const participant = room.participants.get(participantId);
    return participant?.isModerator ?? false;
  }

  kickParticipant(roomId: string, participantId: string): Participant | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const participant = room.participants.get(participantId);
    if (participant) {
      // Close their socket connection
      if (participant.socket.readyState === 1) {
        participant.socket.close();
      }
      this.removeParticipant(roomId, participantId);
      return participant;
    }
    return undefined;
  }
}
