import { NOISE_GATE_PRESETS, VoiceSettings } from './voiceSettings'

/** How often the gate re-reads the input level. 50Hz is well under the shortest attack time. */
const ANALYSIS_INTERVAL_MS = 20

/** Below this the input is silence as far as the meter is concerned, and dB maths stops being useful. */
const SILENCE_RMS = 1e-4

function rmsToDb(rms: number) {
	return 20 * Math.log10(Math.max(rms, SILENCE_RMS))
}

/**
 * The local half of voice chat: raw microphone in, gated and levelled microphone out.
 *
 * The output is a `MediaStream` from a `MediaStreamAudioDestinationNode` rather than the device
 * stream itself, so what peers receive is what the gate lets through. Muting by pausing the track
 * instead would still send the room tone between words in open-mic mode, and would make
 * push-to-talk audibly click.
 *
 * The gate is a classic hysteresis gate: it opens above `openDb`, and only closes once the input
 * has stayed below `closeDb` for `holdMs`. Two thresholds rather than one, because a single one
 * chatters on every syllable boundary — the level dips below it mid-word and the gate slams shut.
 */
export class MicPipeline {
	private readonly context: AudioContext
	private readonly source: MediaStreamAudioSourceNode
	private readonly analyser: AnalyserNode
	private readonly gateGain: GainNode
	private readonly makeupGain: GainNode
	private readonly destination: MediaStreamAudioDestinationNode
	private readonly buffer: Float32Array<ArrayBuffer>
	private readonly timer: ReturnType<typeof setInterval>

	private settings: VoiceSettings
	/** In push-to-talk, false whenever the talk key is up: the gate stays shut regardless of level. */
	private isTransmitting: boolean
	private isOpen = false
	private belowThresholdSince: number | null = null
	private isClosed = false

	/** Smoothed 0–1 input level, for the meter. Not gated: the meter should move while muted too. */
	level = 0
	/** Whether the gate is currently passing audio — i.e. this user is audibly speaking. */
	isSpeaking = false

	constructor(
		private readonly inputStream: MediaStream,
		settings: VoiceSettings,
		isTransmitting: boolean,
		private readonly onSpeakingChange?: (isSpeaking: boolean) => void
	) {
		this.settings = settings
		this.isTransmitting = isTransmitting

		const AudioContextCtor = window.AudioContext ?? (window as any).webkitAudioContext
		this.context = new AudioContextCtor()
		this.source = this.context.createMediaStreamSource(inputStream)
		this.analyser = this.context.createAnalyser()
		this.analyser.fftSize = 512
		this.analyser.smoothingTimeConstant = 0.2
		this.gateGain = this.context.createGain()
		this.gateGain.gain.value = 0
		this.makeupGain = this.context.createGain()
		this.makeupGain.gain.value = settings.inputGain
		this.destination = this.context.createMediaStreamDestination()

		this.source.connect(this.analyser)
		this.source.connect(this.gateGain)
		this.gateGain.connect(this.makeupGain)
		this.makeupGain.connect(this.destination)

		this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4))
		this.timer = setInterval(() => this.tick(), ANALYSIS_INTERVAL_MS)
	}

	/** The stream to send to peers. */
	getOutputStream(): MediaStream {
		return this.destination.stream
	}

	setSettings(settings: VoiceSettings) {
		this.settings = settings
		this.makeupGain.gain.setTargetAtTime(settings.inputGain, this.context.currentTime, 0.05)
	}

	setTransmitting(isTransmitting: boolean) {
		this.isTransmitting = isTransmitting
	}

	private setGate(open: boolean) {
		if (this.isOpen === open) return
		this.isOpen = open
		const preset = NOISE_GATE_PRESETS[this.settings.noiseSuppression]
		// setTargetAtTime is exponential, so it reaches ~95% of the target in three time constants.
		const timeConstant = (open ? preset.attackMs : preset.releaseMs) / 1000 / 3
		this.gateGain.gain.setTargetAtTime(open ? 1 : 0, this.context.currentTime, timeConstant)
		if (this.isSpeaking !== open) {
			this.isSpeaking = open
			this.onSpeakingChange?.(open)
		}
	}

	private tick() {
		if (this.isClosed) return
		this.analyser.getFloatTimeDomainData(this.buffer)
		let sumSquares = 0
		for (let i = 0; i < this.buffer.length; i++) sumSquares += this.buffer[i] * this.buffer[i]
		const rms = Math.sqrt(sumSquares / this.buffer.length)
		this.level = Math.min(1, rms * 4)

		if (!this.isTransmitting) {
			this.belowThresholdSince = null
			this.setGate(false)
			return
		}

		const preset = NOISE_GATE_PRESETS[this.settings.noiseSuppression]
		const db = rmsToDb(rms)

		if (db >= preset.openDb) {
			this.belowThresholdSince = null
			this.setGate(true)
			return
		}

		if (db > preset.closeDb) {
			// Between the two thresholds: hold whatever the gate is already doing.
			this.belowThresholdSince = null
			return
		}

		if (!this.isOpen) return
		const now = Date.now()
		if (this.belowThresholdSince === null) {
			this.belowThresholdSince = now
			return
		}
		if (now - this.belowThresholdSince >= preset.holdMs) this.setGate(false)
	}

	close() {
		if (this.isClosed) return
		this.isClosed = true
		clearInterval(this.timer)
		this.source.disconnect()
		this.analyser.disconnect()
		this.gateGain.disconnect()
		this.makeupGain.disconnect()
		for (const track of this.inputStream.getTracks()) track.stop()
		this.context.close().catch(() => {
			// Closing an already-closed context throws; nothing to recover.
		})
	}
}
