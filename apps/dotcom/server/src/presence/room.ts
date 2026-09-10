import type { WebSocket } from 'ws'
import { ServerConfig } from '../config'
import { getIceServers } from './iceServers'

/**
 * How long a participant can go without sending anything before it is dropped. Browsers do not
 * always deliver a close frame (a laptop lid closing, a killed tab), which would otherwise leave a
 * ghost in the roster and, worse, a peer connection everyone else keeps waiting on.
 */
const PARTICIPANT_TIMEOUT_MS = 45_000
const SWEEP_INTERVAL_MS = 15_000

/** Sent when the roster is full — the mesh is O(n²) connections, so it can't be a big number. */
export const MAX_PARTICIPANTS = 16

/**
 * The largest frame a participant may send. Comfortably above a full SDP offer, which is the
 * biggest thing signalling legitimately carries, and far below what it costs to hold sixteen of
 * them. `signal` payloads are relayed verbatim, so without this one participant can make the room
 * hold and forward whatever size they like.
 */
export const MAX_MESSAGE_BYTES = 32 * 1024

/**
 * Per-participant message budget, as a token bucket: `RATE_BURST` frames may arrive at once and the
 * allowance refills at `RATE_REFILL_PER_SECOND`.
 *
 * Signalling is bursty — a join floods ICE candidates — so a flat per-second cap would break the
 * thing it is protecting. The sustained rate is what matters here: every `hello` and `update` costs
 * a roster broadcast to everyone, so an unmetered sender is amplified by the size of the room.
 */
const RATE_BURST = 80
const RATE_REFILL_PER_SECOND = 20

/**
 * How long a roster change waits for the changes arriving alongside it.
 *
 * Sixteen people unmuting at once used to be sixteen broadcasts of sixteen messages. Short enough
 * that nobody perceives the delay on someone else's mic indicator.
 */
const ROSTER_BROADCAST_DEBOUNCE_MS = 50

interface Participant {
	socket: WebSocket
	id: string
	/** The directory user this connection was authorized as; see `evictUser`. */
	userId: string
	name: string
	/** Stable per identity so the same person keeps their colour across reconnects. */
	color: string
	isSpeaking: boolean
	isMicOn: boolean
	lastSeen: number
	/** Token bucket state; see RATE_BURST. */
	tokens: number
	tokensRefilledAt: number
}

interface PublicParticipant {
	id: string
	name: string
	color: string
	isSpeaking: boolean
	isMicOn: boolean
}

/**
 * One board's live session: who is on it, and the signalling channel their browsers use to build
 * a WebRTC mesh for voice.
 *
 * Deliberately not a document server — board content stays in each client's own IndexedDB. This
 * room holds nothing durable: everything it knows is derived from the sockets currently attached,
 * which is what made it portable off Durable Objects unchanged. It is also why a restart costs
 * nothing but a reconnect.
 *
 * Membership is not checked here: the presence route authorizes the session against the directory
 * before handing the socket over, and passes the user id it resolved. What this room does hold is
 * the mapping from that id back to the live sockets, so the directory can end a session it has
 * just revoked.
 *
 * Message envelopes are `{ type, ... }` JSON both ways. Client → server:
 * - `hello`   `{ name }` — identifies the connection; answered with `welcome`.
 * - `update`  `{ name?, isSpeaking?, isMicOn? }` — partial state change, broadcast as `roster`.
 * - `signal`  `{ to, payload }` — relayed verbatim to that one peer as `signal` `{ from, payload }`.
 * - `ping`    — keeps `lastSeen` fresh.
 *
 * Server → client: `welcome` `{ selfId, participants }`, `roster` `{ participants }`,
 * `ice-servers` `{ iceServers }`, `signal` `{ from, payload }`, `full`, `error` `{ message }`.
 */
export class PresenceRoom {
	private participants = new Map<string, Participant>()
	private sweepTimer: NodeJS.Timeout | null = null
	private rosterTimer: NodeJS.Timeout | null = null

	constructor(
		private readonly config: ServerConfig,
		/** Called when the last participant leaves, so the registry can forget this room. */
		private readonly onEmpty: () => void
	) {}

	/** How many people are on the board, for the health endpoint's roll-up. */
	participantCount() {
		return this.participants.size
	}

	join(socket: WebSocket, userId: string) {
		if (this.participants.size >= MAX_PARTICIPANTS) {
			send(socket, { type: 'full', max: MAX_PARTICIPANTS })
			socket.close(1013, 'Board is full')
			return
		}

		const id = crypto.randomUUID()
		const participant: Participant = {
			socket,
			id,
			userId,
			name: 'Anonymous',
			color: pickColor(id),
			isSpeaking: false,
			isMicOn: false,
			lastSeen: Date.now(),
			tokens: RATE_BURST,
			tokensRefilledAt: Date.now(),
		}
		this.participants.set(id, participant)
		this.ensureSweeper()

		socket.on('message', (data, isBinary) => this.handleMessage(participant, data, isBinary))
		socket.on('close', () => this.removeParticipant(id))
		socket.on('error', () => this.removeParticipant(id))

		send(socket, { type: 'welcome', selfId: id, participants: this.publicParticipants() })
		this.scheduleRosterBroadcast()
		// Sent separately rather than folded into `welcome`, so the roster never waits on credential
		// minting. The client only needs these once someone turns a microphone on, which is always
		// later than this.
		void this.sendIceServers(participant)
	}

	private handleMessage(participant: Participant, data: unknown, isBinary: boolean) {
		participant.lastSeen = Date.now()

		// Binary frames are not part of the protocol, and an oversized one is not worth decoding.
		if (isBinary) return
		const buffer = toBuffer(data)
		if (!buffer || buffer.byteLength > MAX_MESSAGE_BYTES) return

		if (!this.spendToken(participant)) {
			// Closing rather than dropping: a client this far over budget is either broken or not a
			// client, and either way the roster is better off without it. Its peers see it leave and
			// tear down their connections instead of waiting on one that is not coming.
			try {
				participant.socket.close(1008, 'Too many messages')
			} catch {
				// Removing it from the roster is the part that matters.
			}
			this.removeParticipant(participant.id)
			return
		}

		let message: any
		try {
			message = JSON.parse(buffer.toString('utf8'))
		} catch {
			return
		}
		if (!message || typeof message.type !== 'string') return

		switch (message.type) {
			case 'ping':
				return
			case 'hello': {
				// `color` is assigned here and never accepted from the client: it is rendered into
				// every other participant's roster entry, and there is no colour a client could ask
				// for that we would rather have than the stable one their id already picks out.
				if (typeof message.name === 'string') participant.name = trimName(message.name)
				this.scheduleRosterBroadcast()
				return
			}
			case 'update': {
				if (typeof message.name === 'string') participant.name = trimName(message.name)
				if (typeof message.isSpeaking === 'boolean') participant.isSpeaking = message.isSpeaking
				if (typeof message.isMicOn === 'boolean') participant.isMicOn = message.isMicOn
				this.scheduleRosterBroadcast()
				return
			}
			case 'signal': {
				// Relayed rather than interpreted: the offer/answer/ICE payloads are between the two
				// browsers, and this room has no reason to understand them.
				if (typeof message.to !== 'string' || message.to === participant.id) return
				const target = this.participants.get(message.to)
				if (!target) return
				send(target.socket, { type: 'signal', from: participant.id, payload: message.payload })
				return
			}
		}
	}

	/** Takes one token from the participant's budget, refilling it for the time that has passed. */
	private spendToken(participant: Participant): boolean {
		const now = Date.now()
		const elapsedSeconds = (now - participant.tokensRefilledAt) / 1000
		participant.tokens = Math.min(
			RATE_BURST,
			participant.tokens + elapsedSeconds * RATE_REFILL_PER_SECOND
		)
		participant.tokensRefilledAt = now
		if (participant.tokens < 1) return false
		participant.tokens -= 1
		return true
	}

	private async sendIceServers(participant: Participant) {
		const iceServers = await getIceServers(this.config)
		// The participant may well have gone in the meantime; `send` tolerates a dead socket, but
		// there is no point resolving a roster entry that is no longer there.
		if (this.participants.get(participant.id) !== participant) return
		send(participant.socket, { type: 'ice-servers', iceServers })
	}

	/**
	 * Closes every connection this user has on the board, for when their invite is taken away.
	 *
	 * Called by the directory as part of removing a membership, so someone who is on the board — and
	 * in the voice call — at the moment they are removed leaves it then, rather than staying until
	 * they happen to reload. Their peers see them drop out of the roster and tear down their peer
	 * connections, which is what actually ends the audio.
	 */
	evictUser(userId: string) {
		if (!userId) return
		for (const [id, participant] of [...this.participants]) {
			if (participant.userId !== userId) continue
			this.closeParticipant(id, participant, 'Removed from this board')
		}
	}

	/** Ends the whole session, for a board that has been deleted. */
	evictAll() {
		for (const [id, participant] of [...this.participants]) {
			this.closeParticipant(id, participant, 'This board is gone')
		}
	}

	private closeParticipant(id: string, participant: Participant, reason: string) {
		try {
			// 1008 rather than a normal close: the client tells the two apart, and reconnecting to a
			// board you are no longer on would only fail again (see TlaBoardSessionProvider).
			participant.socket.close(1008, reason)
		} catch {
			// Already gone; removing it from the roster is the part that matters.
		}
		this.removeParticipant(id)
	}

	private removeParticipant(id: string) {
		if (!this.participants.delete(id)) return
		this.scheduleRosterBroadcast()
		if (this.participants.size === 0) {
			if (this.sweepTimer) {
				clearInterval(this.sweepTimer)
				this.sweepTimer = null
			}
			this.onEmpty()
		}
	}

	/**
	 * Coalesces roster changes so a burst of them costs one broadcast instead of one each. Every
	 * broadcast is a message to every participant, so the un-coalesced cost of a change is the size
	 * of the room, and the cost of a burst is that multiplied again.
	 */
	private scheduleRosterBroadcast() {
		if (this.rosterTimer) return
		this.rosterTimer = setTimeout(() => {
			this.rosterTimer = null
			this.broadcastRoster()
		}, ROSTER_BROADCAST_DEBOUNCE_MS)
		// The process must be able to exit with a broadcast pending; nothing waits on one.
		this.rosterTimer.unref?.()
	}

	/** Drops participants whose sockets died without a close frame. */
	private ensureSweeper() {
		if (this.sweepTimer) return
		this.sweepTimer = setInterval(() => {
			const cutoff = Date.now() - PARTICIPANT_TIMEOUT_MS
			for (const [id, participant] of this.participants) {
				if (participant.lastSeen >= cutoff) continue
				try {
					participant.socket.close(1001, 'Timed out')
				} catch {
					// Already gone; removing it from the roster is the part that matters.
				}
				this.removeParticipant(id)
			}
		}, SWEEP_INTERVAL_MS)
		this.sweepTimer.unref?.()
	}

	private publicParticipants(): PublicParticipant[] {
		return [...this.participants.values()].map((p) => ({
			id: p.id,
			name: p.name,
			color: p.color,
			isSpeaking: p.isSpeaking,
			isMicOn: p.isMicOn,
		}))
	}

	private broadcastRoster() {
		const participants = this.publicParticipants()
		for (const participant of this.participants.values()) {
			send(participant.socket, { type: 'roster', participants })
		}
	}

	/** Ends every session without the registry bookkeeping, for shutdown. */
	closeAll(code: number, reason: string) {
		if (this.sweepTimer) clearInterval(this.sweepTimer)
		if (this.rosterTimer) clearTimeout(this.rosterTimer)
		for (const participant of this.participants.values()) {
			try {
				participant.socket.close(code, reason)
			} catch {
				// Shutting down regardless.
			}
		}
		this.participants.clear()
	}
}

function toBuffer(data: unknown): Buffer | null {
	if (Buffer.isBuffer(data)) return data
	if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
	if (data instanceof ArrayBuffer) return Buffer.from(data)
	return null
}

function send(socket: WebSocket, message: unknown) {
	try {
		socket.send(JSON.stringify(message))
	} catch {
		// A socket that has already closed will be swept out of the roster shortly.
	}
}

function trimName(name: string) {
	return name.trim().slice(0, 40) || 'Anonymous'
}

/**
 * Cursor colours. Fixed lightness and saturation so no participant's cursor outshouts another's,
 * and so every one stays legible on both the light and dark canvas.
 */
const COLORS = [
	'hsl(220, 90%, 58%)',
	'hsl(268, 74%, 62%)',
	'hsl(330, 78%, 60%)',
	'hsl(8, 82%, 62%)',
	'hsl(32, 88%, 55%)',
	'hsl(150, 62%, 42%)',
	'hsl(188, 74%, 44%)',
]

function pickColor(seed: string) {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
	return COLORS[Math.abs(hash) % COLORS.length]
}
