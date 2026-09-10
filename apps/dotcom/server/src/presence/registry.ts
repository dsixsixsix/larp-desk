import type { WebSocket } from 'ws'
import { ServerConfig } from '../config'
import { PresenceRoom } from './room'

/**
 * The live rooms, one per board that currently has someone on it.
 *
 * This replaces `env.UNO_BOARD_PRESENCE.idFromName(boardId)`: Cloudflare named a Durable Object
 * into existence per board and evicted it when idle, and this is the same shape in one process —
 * created on the first join, dropped on the last leave, so an unvisited board costs nothing.
 *
 * State lives only here, in memory, which is what confines the deployment to a single instance:
 * two processes would each hold half of a board's roster and neither would relay to the other.
 * Scaling out means a shared bus and sticky routing by board id, not a change to this file.
 */
export class PresenceRegistry {
	private rooms = new Map<string, PresenceRoom>()

	constructor(private readonly config: ServerConfig) {}

	join(boardId: string, socket: WebSocket, userId: string) {
		let room = this.rooms.get(boardId)
		if (!room) {
			room = new PresenceRoom(this.config, () => this.rooms.delete(boardId))
			this.rooms.set(boardId, room)
		}
		room.join(socket, userId)
	}

	/** Ends this user's sessions on these boards. A board with no room has nobody to evict. */
	evictUser(boardIds: string[], userId: string) {
		for (const boardId of boardIds) this.rooms.get(boardId)?.evictUser(userId)
	}

	/** Ends every session on these boards, for boards that have been deleted. */
	evictAll(boardIds: string[]) {
		for (const boardId of boardIds) this.rooms.get(boardId)?.evictAll()
	}

	closeAll(code: number, reason: string) {
		for (const room of this.rooms.values()) room.closeAll(code, reason)
		this.rooms.clear()
	}

	stats() {
		let participants = 0
		for (const room of this.rooms.values()) participants += room.participantCount()
		return { rooms: this.rooms.size, participants }
	}
}
