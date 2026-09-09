import {
	ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useValue } from 'tldraw'
import { MULTIPLAYER_SERVER } from '../../utils/config'
import { MicPipeline } from '../utils/voice/micPipeline'
import { getVoiceSettings } from '../utils/voice/voiceSettings'

/** Reconnect backoff bounds for the presence socket. */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15_000
/** Well under the server's 45s participant timeout (see UnoBoardPresenceDurableObject). */
const PING_INTERVAL_MS = 15_000

/**
 * Used until the server's `ice-servers` message arrives, and if it never does.
 *
 * STUN only, so it connects the ordinary home-router case and nothing else: two peers behind
 * symmetric NAT, a firewall that drops UDP, or most VPNs need a relay, and the relay is whatever
 * the worker is configured with (see utils/iceServers.ts there).
 */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
	{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
]

/**
 * How long a peer is allowed to sit in `disconnected` before its ICE is restarted.
 *
 * A short drop — a wifi roam, a few lost packets — heals on its own within a second or two, and
 * restarting through that costs more than it saves. Anything longer is a route that is genuinely
 * gone (a VPN coming up or going down mid-call is the common one) and only a restart recovers it.
 */
const ICE_RECOVERY_DELAY_MS = 2_000
/**
 * Restarts before a peer is given up on and rebuilt from scratch. Bounded because a restart loop
 * against a network that simply cannot carry the connection is just noise.
 */
const MAX_ICE_RESTARTS = 3

interface AudioEncodingParameters extends RTCRtpEncodingParameters {
	/** Opus discontinuous transmission. Shipped in Chrome; not in lib.dom's type yet. */
	dtx?: 'enabled' | 'disabled'
}

/**
 * Opus encoding for a conversation rather than for music.
 *
 * `dtx` stops the encoder spending bandwidth on the silence the gate produces between words, which
 * matters most on exactly the constrained links this is here for: less to send is less to queue,
 * and queueing is what turns into audible delay. `networkPriority` asks the OS to mark the packets
 * so they are the last thing dropped when a link is congested.
 */
const AUDIO_ENCODING: AudioEncodingParameters = {
	dtx: 'enabled',
	networkPriority: 'high',
	priority: 'high',
}

const OUTPUT_DEVICE_KEY = 'tldraw-dotcom:audio-output-device'
const INPUT_DEVICE_KEY = 'tldraw-dotcom:audio-input-device'

export interface BoardParticipant {
	id: string
	name: string
	color: string
	isSpeaking: boolean
	isMicOn: boolean
}

export type VoiceStatus = 'off' | 'starting' | 'on'

/**
 * Why the last attempt to turn the microphone on failed. Separate from `voiceStatus` on purpose:
 * a failed attempt leaves voice *off*, and a control that stays stuck in a failure state can't be
 * clicked back to normal — see TlaVoiceChatButton.
 */
export type VoiceError = 'denied' | 'no-device' | 'in-use' | 'insecure' | 'failed'

export interface BoardSession {
	/** Everyone currently connected to this board, including the local user. */
	participants: BoardParticipant[]
	selfId: string | null
	isConnected: boolean
	voiceStatus: VoiceStatus
	/** Set when the last `startVoice` failed; cleared as soon as another attempt starts. */
	voiceError: VoiceError | null
	/** Local input level, 0–1, for the meter. Moves whether or not the gate is open. */
	micLevel: number
	isSelfSpeaking: boolean
	/** Push-to-talk only: whether the talk key/button is currently held. */
	isTalkHeld: boolean
	startVoice(): Promise<void>
	stopVoice(): void
	setTalkHeld(held: boolean): void
}

const EMPTY_SESSION: BoardSession = {
	participants: [],
	selfId: null,
	isConnected: false,
	voiceStatus: 'off',
	voiceError: null,
	micLevel: 0,
	isSelfSpeaking: false,
	isTalkHeld: false,
	startVoice: async () => {},
	stopVoice: () => {},
	setTalkHeld: () => {},
}

const BoardSessionContext = createContext<BoardSession>(EMPTY_SESSION)

export function useBoardSession() {
	return useContext(BoardSessionContext)
}

interface PeerConnection {
	pc: RTCPeerConnection
	sender: RTCRtpSender
	audio: HTMLAudioElement
	/** Perfect negotiation state — see the WHATWG "perfect negotiation" pattern. */
	makingOffer: boolean
	ignoreOffer: boolean
	isPolite: boolean
	/** ICE restarts attempted since this peer was last connected. */
	restarts: number
	recoveryTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Joins the board's live session: a presence roster shared by everyone on the same board id, and
 * the WebRTC mesh those participants use to talk to each other.
 *
 * Board content is not synced — it stays in each client's own IndexedDB (see localBoards.ts). What
 * is shared is who is here and their audio, which is what the header count and the voice chat need
 * and nothing more.
 *
 * The mesh is only built once someone actually turns their microphone on: a board where nobody is
 * talking costs one websocket per person and no peer connections at all.
 */
export function TlaBoardSessionProvider({
	boardId,
	userName,
	children,
}: {
	boardId: string
	userName: string
	children: ReactNode
}) {
	const [participants, setParticipants] = useState<BoardParticipant[]>([])
	const [selfId, setSelfId] = useState<string | null>(null)
	const [isConnected, setIsConnected] = useState(false)
	const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('off')
	const [voiceError, setVoiceError] = useState<VoiceError | null>(null)
	const [micLevel, setMicLevel] = useState(0)
	const [isSelfSpeaking, setIsSelfSpeaking] = useState(false)
	const [isTalkHeld, setIsTalkHeld] = useState(false)

	const settings = useValue('voice-settings', () => getVoiceSettings().get(), [])

	const socketRef = useRef<WebSocket | null>(null)
	const selfIdRef = useRef<string | null>(null)
	const peersRef = useRef(new Map<string, PeerConnection>())
	const pipelineRef = useRef<MicPipeline | null>(null)
	const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS)
	// Bumped when a peer is given up on, so the mesh effect below rebuilds it. Without it a peer
	// that failed while the roster was unchanged would stay torn down until somebody joined or left.
	const [rebuildTick, setRebuildTick] = useState(0)

	const send = useCallback((message: unknown) => {
		const socket = socketRef.current
		if (socket?.readyState !== WebSocket.OPEN) return
		socket.send(JSON.stringify(message))
	}, [])

	// ---------------------------------------------------------------- peer connections

	const closePeer = useCallback((peerId: string) => {
		const peer = peersRef.current.get(peerId)
		if (!peer) return
		peersRef.current.delete(peerId)
		if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer)
		peer.pc.onconnectionstatechange = null
		peer.pc.onicecandidate = null
		peer.pc.ontrack = null
		peer.pc.onnegotiationneeded = null
		peer.pc.close()
		peer.audio.srcObject = null
		peer.audio.remove()
	}, [])

	/**
	 * Puts a peer whose transport has gone back together, by restarting ICE: the connection keeps
	 * its media and its negotiated codecs and only re-gathers candidates, which is what recovers a
	 * call across a network change (a VPN going up or down mid-call being the usual one).
	 *
	 * The restart re-reads the ICE servers first, so a peer built before the relay credentials
	 * arrived gets them on the way back up rather than retrying against STUN it already couldn't use.
	 * Past the restart budget the peer is dropped and the mesh effect builds a fresh one.
	 */
	const scheduleIceRecovery = useCallback(
		(peerId: string, delayMs: number) => {
			const peer = peersRef.current.get(peerId)
			if (!peer || peer.recoveryTimer) return
			peer.recoveryTimer = setTimeout(() => {
				peer.recoveryTimer = null
				// A blip that healed itself while the timer ran needs nothing.
				if (peersRef.current.get(peerId) !== peer) return
				if (peer.pc.connectionState === 'connected') return

				if (peer.restarts >= MAX_ICE_RESTARTS) {
					closePeer(peerId)
					setRebuildTick((tick) => tick + 1)
					return
				}
				peer.restarts++
				try {
					peer.pc.setConfiguration({
						iceServers: iceServersRef.current,
						bundlePolicy: 'max-bundle',
						rtcpMuxPolicy: 'require',
					})
				} catch {
					// Not every browser allows reconfiguring a live connection; the restart below is
					// still worth trying with the servers it already has.
				}
				peer.pc.restartIce()
			}, delayMs)
		},
		[closePeer]
	)

	const getOrCreatePeer = useCallback(
		(peerId: string) => {
			const existing = peersRef.current.get(peerId)
			if (existing) return existing

			const selfIdValue = selfIdRef.current
			if (!selfIdValue) return null

			const pc = new RTCPeerConnection({
				iceServers: iceServersRef.current,
				// One audio stream on one transport: fewer candidate pairs to check, so the call
				// connects sooner, and one relay allocation instead of several when it goes through TURN.
				bundlePolicy: 'max-bundle',
				rtcpMuxPolicy: 'require',
				// Gather a candidate before there is anything to negotiate, so the offer carries
				// candidates rather than waiting on a STUN round trip after it.
				iceCandidatePoolSize: 1,
			})
			// One transceiver up front, so `replaceTrack` can swap the microphone in and out later
			// without renegotiating. Both sides create it, so the m-line order always matches.
			const transceiver = pc.addTransceiver('audio', {
				direction: 'sendrecv',
				sendEncodings: [AUDIO_ENCODING],
			})

			const audio = document.createElement('audio')
			audio.autoplay = true
			// Kept out of the layout: it exists only to give the remote stream somewhere to play.
			audio.style.display = 'none'
			document.body.appendChild(audio)

			const peer: PeerConnection = {
				pc,
				sender: transceiver.sender,
				audio,
				makingOffer: false,
				ignoreOffer: false,
				// Exactly one side of each pair has to yield on a glare collision; the id comparison
				// is the cheapest way for both sides to agree on which without another round trip.
				// Collisions are rare on the first handshake, since only one side opens the
				// connection — but either side can start an ICE restart, and that is a real one.
				isPolite: selfIdValue < peerId,
				restarts: 0,
				recoveryTimer: null,
			}
			peersRef.current.set(peerId, peer)

			pc.onicecandidate = ({ candidate }) => {
				if (candidate) send({ type: 'signal', to: peerId, payload: { candidate } })
			}
			pc.ontrack = ({ streams }) => {
				audio.srcObject = streams[0] ?? null
				applyOutputDevice(audio)
				audio.play().catch(() => {
					// Autoplay can be blocked until the page has been interacted with; the user
					// turning voice on is itself an interaction, so this is rare and self-healing.
				})
			}
			pc.onnegotiationneeded = async () => {
				try {
					peer.makingOffer = true
					await pc.setLocalDescription()
					send({ type: 'signal', to: peerId, payload: { description: pc.localDescription } })
				} catch {
					// A failed offer is retried by the next negotiationneeded.
				} finally {
					peer.makingOffer = false
				}
			}
			pc.onconnectionstatechange = () => {
				switch (pc.connectionState) {
					case 'connected':
						// The peer is healthy again, so a later failure gets its own full restart budget.
						peer.restarts = 0
						clearRecoveryTimer(peer)
						break
					case 'disconnected':
						scheduleIceRecovery(peerId, ICE_RECOVERY_DELAY_MS)
						break
					case 'failed':
						// Terminal for this ICE generation: nothing heals it on its own.
						scheduleIceRecovery(peerId, 0)
						break
				}
			}

			const track = pipelineRef.current?.getOutputStream().getAudioTracks()[0] ?? null
			if (track) peer.sender.replaceTrack(track)

			return peer
		},
		[send, scheduleIceRecovery]
	)

	const handleSignal = useCallback(
		async (from: string, payload: any) => {
			const peer = getOrCreatePeer(from)
			if (!peer) return
			const { pc } = peer

			try {
				if (payload.description) {
					const isOffer = payload.description.type === 'offer'
					const collision = isOffer && (peer.makingOffer || pc.signalingState !== 'stable')
					peer.ignoreOffer = !peer.isPolite && collision
					if (peer.ignoreOffer) return

					await pc.setRemoteDescription(payload.description)
					if (isOffer) {
						await pc.setLocalDescription()
						send({ type: 'signal', to: from, payload: { description: pc.localDescription } })
					}
				} else if (payload.candidate) {
					try {
						await pc.addIceCandidate(payload.candidate)
					} catch (err) {
						if (!peer.ignoreOffer) throw err
					}
				}
			} catch {
				// A broken handshake is recoverable: the connection state watcher tears the peer
				// down and the roster effect rebuilds it.
			}
		},
		[getOrCreatePeer, send]
	)

	// ------------------------------------------------------------------- presence socket

	useEffect(() => {
		if (!boardId) return
		let isCancelled = false
		let reconnectDelay = RECONNECT_MIN_MS
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null
		let pingTimer: ReturnType<typeof setInterval> | null = null

		const connect = () => {
			if (isCancelled) return
			const url = `${MULTIPLAYER_SERVER}/uno/board/${encodeURIComponent(boardId)}/presence`
			const socket = new WebSocket(url)
			socketRef.current = socket

			socket.onopen = () => {
				if (isCancelled) return
				reconnectDelay = RECONNECT_MIN_MS
				setIsConnected(true)
				socket.send(JSON.stringify({ type: 'hello', name: userName }))
				pingTimer = setInterval(() => {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
				}, PING_INTERVAL_MS)
			}

			socket.onmessage = (event) => {
				let message: any
				try {
					message = JSON.parse(event.data)
				} catch {
					return
				}
				switch (message.type) {
					case 'welcome':
						selfIdRef.current = message.selfId
						setSelfId(message.selfId)
						setParticipants(message.participants ?? [])
						break
					case 'roster':
						setParticipants(message.participants ?? [])
						break
					case 'ice-servers':
						// Relay credentials for the networks STUN can't connect. They arrive shortly
						// after the socket opens, which is well before anyone turns a microphone on —
						// but a peer built in that window is repaired rather than left on STUN.
						if (Array.isArray(message.iceServers) && message.iceServers.length > 0) {
							iceServersRef.current = message.iceServers
							applyIceServers(peersRef.current, message.iceServers)
						}
						break
					case 'signal':
						handleSignal(message.from, message.payload)
						break
					case 'full':
						setVoiceError('failed')
						break
				}
			}

			const scheduleReconnect = () => {
				if (isCancelled || reconnectTimer) return
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null
					connect()
				}, reconnectDelay)
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
			}

			socket.onclose = () => {
				if (pingTimer) clearInterval(pingTimer)
				pingTimer = null
				setIsConnected(false)
				setSelfId(null)
				selfIdRef.current = null
				setParticipants([])
				scheduleReconnect()
			}
			socket.onerror = () => socket.close()
		}

		connect()

		// Captured here rather than read in the cleanup: these hold the session's own resources for
		// as long as the effect runs, and the cleanup has to tear down that session's, not a later
		// board's.
		const peers = peersRef.current
		const pipeline = pipelineRef

		return () => {
			isCancelled = true
			if (reconnectTimer) clearTimeout(reconnectTimer)
			if (pingTimer) clearInterval(pingTimer)
			const socket = socketRef.current
			socketRef.current = null
			if (socket) {
				socket.onclose = null
				socket.onerror = null
				socket.close()
			}
			// Switching boards ends the previous session outright — peers, microphone and all.
			for (const peerId of [...peers.keys()]) closePeer(peerId)
			pipeline.current?.close()
			pipeline.current = null
			setIsConnected(false)
			setParticipants([])
			setSelfId(null)
			setVoiceStatus('off')
			setVoiceError(null)
			setIsSelfSpeaking(false)
			setMicLevel(0)
		}
	}, [boardId, userName, handleSignal, closePeer])

	// Keep the roster's copy of the local name in step with the account dialog.
	useEffect(() => {
		if (isConnected) send({ type: 'update', name: userName })
	}, [userName, isConnected, send])

	// ------------------------------------------------------------------------ the mesh

	// Connect to (and only to) the participants a call is actually needed with: someone has to have
	// their microphone on, or there is nothing to carry.
	useEffect(() => {
		if (!selfId) return
		const self = participants.find((p) => p.id === selfId)
		const wanted = new Set<string>()
		for (const participant of participants) {
			if (participant.id === selfId) continue
			if (self?.isMicOn || participant.isMicOn) wanted.add(participant.id)
		}
		for (const peerId of [...peersRef.current.keys()]) {
			if (!wanted.has(peerId)) closePeer(peerId)
		}
		for (const peerId of wanted) {
			// Only one side of the pair opens the connection, so they don't race to offer first.
			if (peersRef.current.has(peerId) || selfId > peerId) continue
			getOrCreatePeer(peerId)
		}
		// rebuildTick is what re-runs this after a peer was given up on: the roster is unchanged in
		// that case, so nothing else here would notice the gap.
	}, [participants, selfId, rebuildTick, getOrCreatePeer, closePeer])

	// ---------------------------------------------------------------------- microphone

	const stopVoice = useCallback(() => {
		pipelineRef.current?.close()
		pipelineRef.current = null
		for (const peer of peersRef.current.values()) peer.sender.replaceTrack(null)
		setVoiceStatus('off')
		setVoiceError(null)
		setIsSelfSpeaking(false)
		setMicLevel(0)
		setIsTalkHeld(false)
		send({ type: 'update', isMicOn: false, isSpeaking: false })
	}, [send])

	const startVoice = useCallback(async () => {
		if (pipelineRef.current) return
		setVoiceError(null)
		setVoiceStatus('starting')
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				// getUserMedia is only exposed in a secure context; over plain http on a LAN address
				// it is simply missing, which otherwise surfaces as an unexplained failure.
				setVoiceStatus('off')
				setVoiceError('insecure')
				return
			}

			const stream = await getMicrophoneStream()
			const current = getVoiceSettings().get()
			const pipeline = new MicPipeline(
				stream,
				current,
				// Open mode transmits from the moment the mic is on; push-to-talk waits for the key.
				current.mode === 'open',
				(isSpeaking) => {
					setIsSelfSpeaking(isSpeaking)
					send({ type: 'update', isSpeaking })
				}
			)
			pipelineRef.current = pipeline

			const track = pipeline.getOutputStream().getAudioTracks()[0] ?? null
			for (const peer of peersRef.current.values()) peer.sender.replaceTrack(track)

			setVoiceStatus('on')
			send({ type: 'update', isMicOn: true })
		} catch (err: any) {
			// Back to plain "off" rather than a failure state of its own: the button is a toggle, and
			// the reason it failed belongs in a message, not in the toggle's position.
			setVoiceStatus('off')
			setVoiceError(toVoiceError(err))
		}
	}, [send])

	// A peer that joins the mesh after the microphone was turned on needs the track too.
	useEffect(() => {
		const track = pipelineRef.current?.getOutputStream().getAudioTracks()[0] ?? null
		if (!track) return
		for (const peer of peersRef.current.values()) {
			if (peer.sender.track !== track) peer.sender.replaceTrack(track)
		}
	}, [participants])

	useEffect(() => {
		pipelineRef.current?.setSettings(settings)
		// Switching to open mode with the mic already on should start transmitting immediately;
		// switching to push-to-talk should stop until the key goes down.
		pipelineRef.current?.setTransmitting(settings.mode === 'open' || isTalkHeld)
	}, [settings, isTalkHeld])

	const setTalkHeld = useCallback((held: boolean) => {
		setIsTalkHeld(held)
		pipelineRef.current?.setTransmitting(getVoiceSettings().get().mode === 'open' || held)
	}, [])

	// Meter polling is separate from the gate's own 50Hz loop: React doesn't need to re-render
	// that often, and the meter is the only thing that reads the level.
	useEffect(() => {
		if (voiceStatus !== 'on') return
		const timer = setInterval(() => setMicLevel(pipelineRef.current?.level ?? 0), 100)
		return () => clearInterval(timer)
	}, [voiceStatus])

	const value = useMemo<BoardSession>(
		() => ({
			participants,
			selfId,
			isConnected,
			voiceStatus,
			voiceError,
			micLevel,
			isSelfSpeaking,
			isTalkHeld,
			startVoice,
			stopVoice,
			setTalkHeld,
		}),
		[
			participants,
			selfId,
			isConnected,
			voiceStatus,
			voiceError,
			micLevel,
			isSelfSpeaking,
			isTalkHeld,
			startVoice,
			stopVoice,
			setTalkHeld,
		]
	)

	return <BoardSessionContext.Provider value={value}>{children}</BoardSessionContext.Provider>
}

function applyIceServers(peers: Map<string, PeerConnection>, iceServers: RTCIceServer[]) {
	for (const peer of peers.values()) {
		try {
			peer.pc.setConfiguration({
				iceServers,
				bundlePolicy: 'max-bundle',
				rtcpMuxPolicy: 'require',
			})
		} catch {
			// Reconfiguring a live connection isn't universally supported; the peer keeps the servers
			// it was built with, and an ICE restart is the next chance to pick these up.
		}
	}
}

function clearRecoveryTimer(peer: PeerConnection) {
	if (!peer.recoveryTimer) return
	clearTimeout(peer.recoveryTimer)
	peer.recoveryTimer = null
}

function readLocalStorage(key: string): string {
	try {
		return window.localStorage.getItem(key) ?? ''
	} catch {
		return ''
	}
}

function applyOutputDevice(audio: HTMLAudioElement) {
	const deviceId = readLocalStorage(OUTPUT_DEVICE_KEY)
	if (!deviceId || !('setSinkId' in audio)) return
	;(audio as any).setSinkId(deviceId).catch(() => {
		// Falls back to the system default output.
	})
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
	// The browser's own processing runs ahead of our gate: it removes the echo and steady-state
	// noise that a gate can't, and the gate then removes what's left between words, which the
	// browser's own suppression leaves through.
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
}

/**
 * Opens the microphone, preferring the device chosen in settings.
 *
 * A saved device id is a weak preference, not a requirement. Ids are scoped to the origin and are
 * only issued once permission has been granted, so a stored one goes stale in all the ordinary
 * ways — the device was unplugged, the browser's site data was cleared, the id was recorded before
 * permission existed. Asking for it with `exact` then fails with OverconstrainedError, which reads
 * to the user as "no microphone found" on a machine that plainly has one. So: try the chosen
 * device, and on a constraint failure fall back to the system default and forget the id.
 */
async function getMicrophoneStream(): Promise<MediaStream> {
	const preferredDeviceId = readLocalStorage(INPUT_DEVICE_KEY)
	if (!preferredDeviceId) {
		return await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
	}

	try {
		return await navigator.mediaDevices.getUserMedia({
			audio: { ...MIC_CONSTRAINTS, deviceId: { exact: preferredDeviceId } },
		})
	} catch (err: any) {
		if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err
		const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
		// Only cleared once the fallback has actually worked, so a transient failure doesn't throw
		// away a choice that is still valid.
		try {
			window.localStorage.removeItem(INPUT_DEVICE_KEY)
		} catch {
			// Storage disabled; the preference was never going to persist anyway.
		}
		return stream
	}
}

function toVoiceError(err: any): VoiceError {
	switch (err?.name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return 'denied'
		case 'NotFoundError':
		case 'OverconstrainedError':
			return 'no-device'
		// Another application holds the device, or the OS refused to open it.
		case 'NotReadableError':
		case 'AbortError':
			return 'in-use'
		default:
			return 'failed'
	}
}
