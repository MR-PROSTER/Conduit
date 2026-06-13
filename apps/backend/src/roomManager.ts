export interface ManagedRoom {
  roomKey: string;
  session: {
    roomId: string;
    branch: string;
    sessionId: string;
  };
  connectionCount: number;
  lastTouchedAt: Date;
}

export class RoomManager {
  private activeRooms = new Map<string, ManagedRoom>();

  /**
   * Registers a connection to a room. If the room doesn't exist, it is created.
   * Otherwise, its connection count is incremented.
   */
  register(
    roomKey: string,
    session: { roomId: string; branch: string; sessionId: string },
  ): ManagedRoom {
    const existing = this.activeRooms.get(roomKey);
    if (existing) {
      existing.connectionCount++;
      existing.lastTouchedAt = new Date();
      return existing;
    }

    const newRoom: ManagedRoom = {
      roomKey,
      session,
      connectionCount: 1,
      lastTouchedAt: new Date(),
    };
    this.activeRooms.set(roomKey, newRoom);
    return newRoom;
  }

  /**
   * Decrements connection count for a room.
   * If the connection count reaches 0, the room is unregistered (removed).
   */
  unregister(roomKey: string): void {
    const existing = this.activeRooms.get(roomKey);
    if (existing) {
      existing.connectionCount--;
      existing.lastTouchedAt = new Date();
      if (existing.connectionCount <= 0) {
        this.activeRooms.delete(roomKey);
      }
    }
  }

  /**
   * Returns a list of all currently managed rooms.
   */
  list(): ManagedRoom[] {
    return Array.from(this.activeRooms.values());
  }

  /**
   * Updates the lastTouchedAt timestamp for a room.
   */
  touch(roomKey: string): void {
    const existing = this.activeRooms.get(roomKey);
    if (existing) {
      existing.lastTouchedAt = new Date();
    }
  }

  /**
   * Retrieves a managed room by its key.
   */
  get(roomKey: string): ManagedRoom | undefined {
    return this.activeRooms.get(roomKey);
  }
}
