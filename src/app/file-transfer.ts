import type { SignalingClient } from "./signaling.js";
import type { FileTransfer } from "./types.js";

export type FileTransferEventType =
  | "transfer-started"
  | "transfer-progress"
  | "transfer-completed"
  | "transfer-cancelled"
  | "transfer-error"
  | "file-offer-received";

export interface FileTransferEvent {
  type: FileTransferEventType;
  transferId: string;
  transfer?: FileTransfer;
  progress?: number;
  error?: Error;
}

export type FileTransferEventHandler = (event: FileTransferEvent) => void;

const CHUNK_SIZE = 16384; // 16KB chunks

export class FileTransferManager {
  private transfers: Map<string, FileTransfer> = new Map();
  private eventHandlers: Set<FileTransferEventHandler> = new Set();
  private dataChannels: Map<string, RTCDataChannel> = new Map();

  constructor(
    private signaling: SignalingClient,
    private roomId: string,
    private participantId: string,
  ) {}

  onEvent(handler: FileTransferEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private emit(event: FileTransferEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  // Send a file to another participant
  async sendFile(targetId: string, file: File, peerConnection: RTCPeerConnection): Promise<string> {
    const transferId = `${this.participantId}-${targetId}-${Date.now()}`;

    // Create data channel for file transfer
    const dataChannel = peerConnection.createDataChannel(`file-${transferId}`, {
      ordered: true,
    });

    this.dataChannels.set(transferId, dataChannel);

    const transfer: FileTransfer = {
      id: transferId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      senderId: this.participantId,
      senderName: "You",
      chunks: [],
      receivedChunks: 0,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
    };

    this.transfers.set(transferId, transfer);

    // Wait for data channel to open
    await new Promise<void>((resolve, reject) => {
      dataChannel.onopen = () => resolve();
      dataChannel.onerror = (error) => reject(error);
      setTimeout(() => reject(new Error("Data channel timeout")), 10000);
    });

    // Send file offer via signaling
    this.signaling.sendFileOffer(
      targetId,
      this.roomId,
      this.participantId,
      file.name,
      file.size,
      file.type,
    );

    this.emit({
      type: "transfer-started",
      transferId,
      transfer,
    });

    return transferId;
  }

  // Handle incoming file offer
  handleFileOffer(
    transferId: string,
    senderId: string,
    senderName: string,
    fileName: string,
    fileSize: number,
    fileType: string,
  ): void {
    const transfer: FileTransfer = {
      id: transferId,
      fileName,
      fileSize,
      fileType,
      senderId,
      senderName,
      chunks: [],
      receivedChunks: 0,
      totalChunks: Math.ceil(fileSize / CHUNK_SIZE),
    };

    this.transfers.set(transferId, transfer);

    this.emit({
      type: "file-offer-received",
      transferId,
      transfer,
    });
  }

  // Accept file transfer
  async acceptFile(transferId: string, peerConnection: RTCPeerConnection): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    // Create data channel for receiving
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === `file-${transferId}`) {
        this.dataChannels.set(transferId, channel);
        this.setupDataChannel(channel, transferId);
      }
    };

    // Accept via signaling
    this.signaling.sendFileAnswer(transfer.senderId, this.roomId, this.participantId, true);

    this.emit({
      type: "transfer-started",
      transferId,
      transfer,
    });
  }

  // Reject file transfer
  rejectFile(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    this.signaling.sendFileAnswer(transfer.senderId, this.roomId, this.participantId, false);

    this.transfers.delete(transferId);

    this.emit({
      type: "transfer-cancelled",
      transferId,
    });
  }

  // Actually send file chunks via data channel
  async sendFileChunks(transferId: string, file: File): Promise<void> {
    const transfer = this.transfers.get(transferId);
    const dataChannel = this.dataChannels.get(transferId);

    if (!transfer || !dataChannel) return;

    try {
      const totalChunks = transfer.totalChunks;

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const arrayBuffer = await chunk.arrayBuffer();
        const base64Chunk = this.arrayBufferToBase64(arrayBuffer);

        // Send chunk via data channel
        if (dataChannel.readyState === "open") {
          dataChannel.send(
            JSON.stringify({
              type: "chunk",
              index: i,
              total: totalChunks,
              data: base64Chunk,
            }),
          );
        } else {
          // Fallback to signaling if data channel not available
          this.signaling.sendFileChunk(
            transfer.senderId,
            this.roomId,
            this.participantId,
            base64Chunk,
            i,
            totalChunks,
          );
        }

        // Update progress
        const progress = ((i + 1) / totalChunks) * 100;
        this.emit({
          type: "transfer-progress",
          transferId,
          progress,
        });

        // Small delay to prevent overwhelming the connection
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Complete the transfer
      transfer.blob = file;
      this.emit({
        type: "transfer-completed",
        transferId,
        transfer,
      });
    } catch (error) {
      console.error("Failed to send file chunks:", error);
      this.emit({
        type: "transfer-error",
        transferId,
        error: error instanceof Error ? error : new Error("Transfer failed"),
      });
    }
  }

  // Handle incoming file chunk
  handleFileChunk(transferId: string, chunk: string, index: number, total: number): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    transfer.chunks[index] = chunk;
    transfer.receivedChunks++;

    const progress = (transfer.receivedChunks / total) * 100;
    this.emit({
      type: "transfer-progress",
      transferId,
      progress,
    });

    // Check if all chunks received
    if (transfer.receivedChunks === total) {
      this.assembleFile(transferId);
    }
  }

  private setupDataChannel(channel: RTCDataChannel, transferId: string): void {
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "chunk") {
          this.handleFileChunk(transferId, data.data, data.index, data.total);
        }
      } catch (error) {
        console.error("Failed to parse data channel message:", error);
      }
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
      this.emit({
        type: "transfer-error",
        transferId,
        error: new Error("Data channel error"),
      });
    };
  }

  private assembleFile(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    try {
      // Combine all chunks
      const base64Data = transfer.chunks.join("");
      const byteArray = this.base64ToArrayBuffer(base64Data);

      // Create blob
      transfer.blob = new Blob([byteArray], { type: transfer.fileType });

      this.emit({
        type: "transfer-completed",
        transferId,
        transfer,
      });
    } catch (error) {
      console.error("Failed to assemble file:", error);
      this.emit({
        type: "transfer-error",
        transferId,
        error: error instanceof Error ? error : new Error("Assembly failed"),
      });
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  getTransfer(transferId: string): FileTransfer | undefined {
    return this.transfers.get(transferId);
  }

  getAllTransfers(): FileTransfer[] {
    return Array.from(this.transfers.values());
  }

  removeTransfer(transferId: string): void {
    const channel = this.dataChannels.get(transferId);
    if (channel) {
      channel.close();
      this.dataChannels.delete(transferId);
    }
    this.transfers.delete(transferId);
  }

  cancelTransfer(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      this.signaling.sendFileAnswer(transfer.senderId, this.roomId, this.participantId, false);
    }
    this.removeTransfer(transferId);

    this.emit({
      type: "transfer-cancelled",
      transferId,
    });
  }

  downloadFile(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer?.blob) return;

    const url = URL.createObjectURL(transfer.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = transfer.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
