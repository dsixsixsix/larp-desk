import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicPipeline } from './micPipeline'
import { DEFAULT_VOICE_SETTINGS, NOISE_GATE_PRESETS, VoiceSettings } from './voiceSettings'

/**
 * jsdom has no Web Audio, so the graph is stubbed down to the parts the gate actually drives: a
 * gain node whose value it ramps, and an analyser it reads a level from. `setTargetAtTime` is
 * treated as immediate — the ramp shape is the browser's job, and what's under test is which
 * target the gate picks and when.
 */
let analyserLevel = 0

class FakeAudioParam {
	value = 0
	setTargetAtTime = vi.fn((target: number) => {
		this.value = target
	})
}

class FakeGainNode {
	gain = new FakeAudioParam()
	connect = vi.fn()
	disconnect = vi.fn()
}

class FakeAnalyserNode {
	fftSize = 512
	smoothingTimeConstant = 0
	connect = vi.fn()
	disconnect = vi.fn()
	getFloatTimeDomainData(buffer: Float32Array) {
		// A constant-amplitude signal, so RMS is exactly `analyserLevel`.
		buffer.fill(analyserLevel)
	}
}

class FakeAudioContext {
	currentTime = 0
	gainNodes: FakeGainNode[] = []
	createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
	createAnalyser = vi.fn(() => new FakeAnalyserNode())
	createGain = vi.fn(() => {
		const node = new FakeGainNode()
		this.gainNodes.push(node)
		return node
	})
	createMediaStreamDestination = vi.fn(() => ({ stream: { getAudioTracks: () => [] } }))
	close = vi.fn(() => Promise.resolve())
}

function dbToAmplitude(db: number) {
	return Math.pow(10, db / 20)
}

function makePipeline(settings: Partial<VoiceSettings> = {}, isTransmitting = true) {
	const stream = { getTracks: () => [] } as unknown as MediaStream
	const onSpeakingChange = vi.fn()
	const pipeline = new MicPipeline(
		stream,
		{ ...DEFAULT_VOICE_SETTINGS, ...settings },
		isTransmitting,
		onSpeakingChange
	)
	// The gate gain is the first gain node created (see the constructor's graph).
	const context = (pipeline as any).context as FakeAudioContext
	return { pipeline, onSpeakingChange, gateGain: context.gainNodes[0] }
}

describe('MicPipeline noise gate', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		analyserLevel = 0
		;(window as any).AudioContext = FakeAudioContext
	})

	afterEach(() => {
		vi.useRealTimers()
		delete (window as any).AudioContext
	})

	it('starts closed', () => {
		const { gateGain, pipeline } = makePipeline()
		expect(gateGain.gain.value).toBe(0)
		expect(pipeline.isSpeaking).toBe(false)
	})

	it('opens once the input passes the open threshold', () => {
		const { pipeline, gateGain, onSpeakingChange } = makePipeline({ noiseSuppression: 'medium' })
		analyserLevel = dbToAmplitude(NOISE_GATE_PRESETS.medium.openDb + 5)
		vi.advanceTimersByTime(40)
		expect(gateGain.gain.value).toBe(1)
		expect(pipeline.isSpeaking).toBe(true)
		expect(onSpeakingChange).toHaveBeenCalledWith(true)
	})

	it('stays open between the two thresholds instead of chattering', () => {
		const { pipeline } = makePipeline({ noiseSuppression: 'medium' })
		analyserLevel = dbToAmplitude(NOISE_GATE_PRESETS.medium.openDb + 5)
		vi.advanceTimersByTime(40)
		expect(pipeline.isSpeaking).toBe(true)

		// Halfway between close and open: the quiet part of a word.
		analyserLevel = dbToAmplitude(
			(NOISE_GATE_PRESETS.medium.openDb + NOISE_GATE_PRESETS.medium.closeDb) / 2
		)
		vi.advanceTimersByTime(2000)
		expect(pipeline.isSpeaking).toBe(true)
	})

	it('closes only after the hold time has elapsed below the close threshold', () => {
		const { pipeline, gateGain } = makePipeline({ noiseSuppression: 'medium' })
		analyserLevel = dbToAmplitude(NOISE_GATE_PRESETS.medium.openDb + 5)
		vi.advanceTimersByTime(40)
		expect(pipeline.isSpeaking).toBe(true)

		analyserLevel = dbToAmplitude(NOISE_GATE_PRESETS.medium.closeDb - 10)
		vi.advanceTimersByTime(NOISE_GATE_PRESETS.medium.holdMs - 60)
		expect(pipeline.isSpeaking).toBe(true)

		vi.advanceTimersByTime(120)
		expect(pipeline.isSpeaking).toBe(false)
		expect(gateGain.gain.value).toBe(0)
	})

	it('cuts a level that passes the low threshold but not the high one', () => {
		const between = dbToAmplitude(
			(NOISE_GATE_PRESETS.low.openDb + NOISE_GATE_PRESETS.high.openDb) / 2
		)

		const low = makePipeline({ noiseSuppression: 'low' })
		analyserLevel = between
		vi.advanceTimersByTime(40)
		expect(low.pipeline.isSpeaking).toBe(true)
		low.pipeline.close()

		const high = makePipeline({ noiseSuppression: 'high' })
		analyserLevel = between
		vi.advanceTimersByTime(40)
		expect(high.pipeline.isSpeaking).toBe(false)
	})

	it('keeps the gate shut while push-to-talk is not held, however loud the input', () => {
		const { pipeline, gateGain } = makePipeline({ mode: 'push-to-talk' }, false)
		analyserLevel = 0.9
		vi.advanceTimersByTime(200)
		expect(pipeline.isSpeaking).toBe(false)
		expect(gateGain.gain.value).toBe(0)

		pipeline.setTransmitting(true)
		vi.advanceTimersByTime(40)
		expect(pipeline.isSpeaking).toBe(true)
	})

	it('closes the gate as soon as the talk key is released', () => {
		const { pipeline } = makePipeline({ mode: 'push-to-talk' }, true)
		analyserLevel = 0.9
		vi.advanceTimersByTime(40)
		expect(pipeline.isSpeaking).toBe(true)

		pipeline.setTransmitting(false)
		vi.advanceTimersByTime(40)
		expect(pipeline.isSpeaking).toBe(false)
	})

	it('stops reading the input once closed', () => {
		const { pipeline } = makePipeline()
		pipeline.close()
		analyserLevel = 0.9
		vi.advanceTimersByTime(500)
		expect(pipeline.isSpeaking).toBe(false)
	})
})

describe('noise gate presets', () => {
	it('gets stricter as the level goes up', () => {
		const { low, medium, high } = NOISE_GATE_PRESETS
		expect(low.openDb).toBeLessThan(medium.openDb)
		expect(medium.openDb).toBeLessThan(high.openDb)
	})

	it('always closes below where it opens, so the gate has hysteresis', () => {
		for (const preset of Object.values(NOISE_GATE_PRESETS)) {
			expect(preset.closeDb).toBeLessThan(preset.openDb)
		}
	})
})
