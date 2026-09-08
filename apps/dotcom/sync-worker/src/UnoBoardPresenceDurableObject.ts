import { DurableObject } from 'cloudflare:workers'
import { Environment } from './types'

/**
 * How long a participant can go without sending anything before it is dropped. Browsers do not
 * always deliver a close frame (a laptop lid closing, a killed tab), which would otherwise leave a
 * ghost in the roster and, worse, a peer connection everyone else keeps waiting on.
 */
const PARTICIPANT_TIMEOUT_MS = 45_000
const SWEEP_INTERVAL_MS = 15_000

/** Sent when the roster is full — the mesh is O(n²) connections, so it can't be a big number. */
export const MAX_PARTICIPANTS = 16

interface Participant {
	socket: WebSocket
	id: string
	name: string
	/** Stable per identity so the same person keeps their colour across reconnects. */
	color: string
	isSpeaking: boolean
	isMicOn: boolean
	lastSeen: number
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
 * Deliberately not a document server — board content stays in each client's own IndexedDB (see
 * localBoards.ts in the client). This object holds no durable storage at all: everything it knows
 * is derived from the sockets currently attached, so an eviction between sessions costs nothing.
 *
 * Message envelopes are `{ type, ... }` JSON both ways. Client → server:
 * - `hello`   `{ name, color }` — identifies the connection; answered with `welcome`.
 * - `update`  `{ name?, isSpeaking?, isMicOn? }` — partial state change, broadcast as `roster`.
 * - `signal`  `{ to, payload }` — relayed verbatim to that one peer as `signal` `{ from, payload }`.
 * - `ping`    — keeps `lastSeen` fresh.
 *
 * Server → client: `welcome` `{ selfId, participants }`, `roster` `{ participants }`,
 * `signal` `{ from, payload }`, `full`, `error` `{ message }`.
 */
export class UnoBoardPresenceDurableObject extends DurableObject<Environment> {
	private participants = new Map<string, Participant>()
	private sweepTimer: ReturnType<typeof setInterval> | null = null

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected websocket', { status: 400 })
		}

		const pair = new WebSocketPair()
		const client = pair[0]
		const server = pair[1]
		server.accept()

		if (this.participants.size >= MAX_PARTICIPANTS) {
			server.send(JSON.stringify({ type: 'full', max: MAX_PARTICIPANTS }))
			server.close(1013, 'Board is full')
			return new Response(null, { status: 101, webSocket: client })
		}

		const id = crypto.randomUUID()
		const participant: Participant = {
			socket: server,
			id,
			name: 'Anonymous',
			color: pickColor(id),
			isSpeaking: false,
			isMicOn: false,
			lastSeen: Date.now(),
		}
		this.participants.set(id, participant)
		this.ensureSweeper()

		server.addEventListener('message', (event) => this.handleMessage(participant, event))
		server.addEventListener('close', () => this.removeParticipant(id))
		server.addEventListener('error', () => this.removeParticipant(id))

		server.send(
			JSON.stringify({ type: 'welcome', selfId: id, participants: this.publicParticipants() })
		)
		this.broadcastRoster()

		return new Response(null, { status: 101, webSocket: client })
	}

	private handleMessage(participant: Participant, event: MessageEvent) {
		participant.lastSeen = Date.now()

		let message: any
		try {
			message = JSON.parse(typeof event.data === 'string' ? event.data : '')
		} catch {
			return
		}
		if (!message || typeof message.type !== 'string') return

		switch (message.type) {
			case 'ping':
				return
			case 'hello': {
				if (typeof message.name === 'string') participant.name = trimName(message.name)
				if (typeof message.color === 'string') participant.color = message.color
				this.broadcastRoster()
				return
			}
			case 'update': {
				if (typeof message.name === 'string') participant.name = trimName(message.name)
				if (typeof message.isSpeaking === 'boolean') participant.isSpeaking = message.isSpeaking
				if (typeof message.isMicOn === 'boolean') participant.isMicOn = message.isMicOn
				this.broadcastRoster()
				return
			}
			case 'signal': {
				// Relayed rather than interpreted: the offer/answer/ICE payloads are between the two
				// browsers, and this object has no reason to understand them.
				const target = this.participants.get(message.to)
				if (!target) return
				send(target.socket, { type: 'signal', from: participant.id, payload: message.payload })
				return
			}
		}
	}

	private removeParticipant(id: string) {
		if (!this.participants.delete(id)) return
		this.broadcastRoster()
		if (this.participants.size === 0 && this.sweepTimer) {
			clearInterval(this.sweepTimer)
			this.sweepTimer = null
		}
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
