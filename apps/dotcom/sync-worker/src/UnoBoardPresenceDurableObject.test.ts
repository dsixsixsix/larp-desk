import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {
		constructor(
			readonly ctx: any,
			readonly env: any
		) {}
	},
}))

vi.mock('./utils/iceServers', () => ({
	getIceServers: async () => [],
}))

/**
 * The sockets a participant is attached through, driven directly: the object only ever talks to a
 * WebSocket, so a pair of fakes is enough to exercise the guards without a runtime.
 */
class FakeSocket {
	readonly sent: any[] = []
	closedWith: { code: number; reason: string } | null = null
	private listeners = new Map<string, ((event: any) => void)[]>()

	accept() {}
	send(data: string) {
		this.sent.push(JSON.parse(data))
	}
	close(code: number, reason: string) {
		this.closedWith = { code, reason }
	}
	addEventListener(type: string, fn: (event: any) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
	}
	emit(type: string, event: any) {
		for (const fn of this.listeners.get(type) ?? []) fn(event)
	}
	messagesOfType(type: string) {
		return this.sent.filter((m) => m.type === type)
	}
}

async function connect(object: any) {
	const client = new FakeSocket()
	const server = new FakeSocket()
	vi.stubGlobal(
		'WebSocketPair',
		class {
			0 = client
			1 = server
		}
	)
	// The handler registers the participant and attaches its listeners before returning, and its
	// return is a 101 — a status the workerd Response accepts and Node's does not. Everything under
	// test has already happened by the time it throws.
	await object
		.fetch(new Request('https://x/presence', { headers: { upgrade: 'websocket' } }))
		.catch(() => {})
	return server
}

describe('UnoBoardPresenceDurableObject', () => {
	let UnoBoardPresenceDurableObject: any
	let object: any

	beforeEach(async () => {
		vi.useFakeTimers()
		;({ UnoBoardPresenceDurableObject } = await import('./UnoBoardPresenceDurableObject'))
		object = new UnoBoardPresenceDurableObject({} as any, {} as any)
	})

	it('never lets a client choose the colour other participants see', async () => {
		const server = await connect(object)
		const welcome = server.messagesOfType('welcome')[0]
		const assigned = welcome.participants[0].color

		server.emit('message', {
			data: JSON.stringify({ type: 'hello', name: 'x', color: 'url(https://attacker/beacon)' }),
		})
		await vi.advanceTimersByTimeAsync(100)

		const roster = server.messagesOfType('roster').at(-1)
		expect(roster.participants[0].color).toBe(assigned)
	})

	it('drops a frame larger than the message cap without acting on it', async () => {
		const server = await connect(object)
		// Joining schedules a roster broadcast of its own; let it land so the count below is only
		// what the oversized frame caused.
		await vi.advanceTimersByTimeAsync(100)
		const before = server.messagesOfType('roster').length

		server.emit('message', {
			data: JSON.stringify({ type: 'hello', name: 'a'.repeat(64 * 1024) }),
		})
		await vi.advanceTimersByTimeAsync(100)

		expect(server.messagesOfType('roster').length).toBe(before)
		expect(server.closedWith).toBeNull()
	})

	it('closes a connection that spends its message budget', async () => {
		const server = await connect(object)
		for (let i = 0; i < 200; i++) {
			server.emit('message', { data: JSON.stringify({ type: 'ping' }) })
		}

		expect(server.closedWith).toEqual({ code: 1008, reason: 'Too many messages' })
	})

	it('coalesces a burst of roster changes into one broadcast', async () => {
		const server = await connect(object)
		await vi.advanceTimersByTimeAsync(100)
		const before = server.messagesOfType('roster').length

		for (let i = 0; i < 10; i++) {
			server.emit('message', { data: JSON.stringify({ type: 'update', isSpeaking: i % 2 === 0 }) })
		}
		await vi.advanceTimersByTimeAsync(100)

		expect(server.messagesOfType('roster').length - before).toBe(1)
	})

	it('does not relay a signal a participant addresses to itself', async () => {
		const server = await connect(object)
		const welcome = server.messagesOfType('welcome')[0]

		server.emit('message', {
			data: JSON.stringify({ type: 'signal', to: welcome.selfId, payload: { x: 1 } }),
		})

		expect(server.messagesOfType('signal')).toHaveLength(0)
	})
})
