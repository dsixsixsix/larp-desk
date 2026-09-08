import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorageState, useValue } from 'tldraw'
import { defineMessages, useIntl, useMsg } from '../../utils/i18n'
import {
	NoiseSuppressionLevel,
	VoiceMode,
	getVoiceSettings,
	updateVoiceSettings,
} from '../../utils/voice/voiceSettings'
import styles from './audio-settings.module.css'

const INPUT_DEVICE_KEY = 'tldraw-dotcom:audio-input-device'
const OUTPUT_DEVICE_KEY = 'tldraw-dotcom:audio-output-device'

const RECORD_SECONDS = 4

const SINK_ID_SUPPORTED =
	typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

const messages = defineMessages({
	microphone: { defaultMessage: 'Microphone' },
	speaker: { defaultMessage: 'Speaker' },
	systemDefault: { defaultMessage: 'System default' },
	noMicrophone: { defaultMessage: 'No microphone found' },
	sinkUnsupported: {
		defaultMessage: "This browser can't choose an output device — using the system default.",
	},
	test: { defaultMessage: 'Test microphone' },
	stop: { defaultMessage: 'Stop' },
	secondsLeft: { defaultMessage: '{seconds}s' },
	recording: { defaultMessage: 'Recording… say something' },
	play: { defaultMessage: 'Play back' },
	playing: { defaultMessage: 'Playing…' },
	recordAgain: { defaultMessage: 'Record again' },
	permissionDenied: {
		defaultMessage: 'Microphone access was denied. Allow it in your browser settings to test.',
	},
	noDeviceError: { defaultMessage: "Couldn't reach a microphone." },
	mode: { defaultMessage: 'Microphone mode' },
	pushToTalk: { defaultMessage: 'Push to talk' },
	pushToTalkHelp: { defaultMessage: 'The microphone is muted until you hold the talk key (V).' },
	openMic: { defaultMessage: 'Always on' },
	openMicHelp: {
		defaultMessage: 'The microphone is live, and the noise gate decides what is sent.',
	},
	noiseSuppression: { defaultMessage: 'Noise suppression' },
	low: { defaultMessage: 'Low' },
	medium: { defaultMessage: 'Medium' },
	high: { defaultMessage: 'High' },
	noiseSuppressionHelp: {
		defaultMessage:
			'Higher settings cut more background noise, but can clip the start of quiet speech.',
	},
	inputGain: { defaultMessage: 'Input volume' },
})

interface Device {
	deviceId: string
	label: string
}

type TestState =
	| { status: 'idle' }
	| { status: 'requesting' }
	| { status: 'recording'; secondsLeft: number }
	| { status: 'recorded'; url: string }
	| { status: 'playing'; url: string }
	| { status: 'error'; message: string }

function labelDevices(
	devices: MediaDeviceInfo[],
	kind: MediaDeviceKind,
	fallback: string
): Device[] {
	return devices
		.filter((d) => d.kind === kind)
		.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
}

/** A live level meter fed by an AnalyserNode — moves while the mic picks up sound, regardless of
 *  whether the recording/playback round trip below also works, so it's useful feedback on its own. */
function useLevelMeter(stream: MediaStream | null): number {
	const [level, setLevel] = useState(0)
	useEffect(() => {
		if (!stream) {
			setLevel(0)
			return
		}
		const AudioContextCtor = window.AudioContext ?? (window as any).webkitAudioContext
		const context = new AudioContextCtor()
		const source = context.createMediaStreamSource(stream)
		const analyser = context.createAnalyser()
		analyser.fftSize = 256
		source.connect(analyser)
		const data = new Uint8Array(analyser.frequencyBinCount)
		let raf = 0
		const tick = () => {
			analyser.getByteTimeDomainData(data)
			let sumSquares = 0
			for (let i = 0; i < data.length; i++) {
				const centered = (data[i] - 128) / 128
				sumSquares += centered * centered
			}
			const rms = Math.sqrt(sumSquares / data.length)
			setLevel(Math.min(1, rms * 4))
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => {
			cancelAnimationFrame(raf)
			source.disconnect()
			analyser.disconnect()
			context.close()
		}
	}, [stream])
	return level
}

/**
 * Input/output device pickers plus a "can I be heard" test: record a few seconds from the chosen
 * microphone and play it back through the chosen speaker, so the user hears their own voice
 * instead of just trusting a level meter. Lives in the local settings dialog since there's no
 * server-side user profile for the scratch canvas to store this on — see TlaLocalAccountDialog.
 */
export function TlaAudioDeviceSettings() {
	const intl = useIntl()
	const microphoneLbl = useMsg(messages.microphone)
	const speakerLbl = useMsg(messages.speaker)
	const systemDefaultLbl = useMsg(messages.systemDefault)
	const noMicrophoneLbl = useMsg(messages.noMicrophone)
	const sinkUnsupportedLbl = useMsg(messages.sinkUnsupported)
	const testLbl = useMsg(messages.test)
	const stopLbl = useMsg(messages.stop)
	const recordingLbl = useMsg(messages.recording)
	const playLbl = useMsg(messages.play)
	const playingLbl = useMsg(messages.playing)
	const recordAgainLbl = useMsg(messages.recordAgain)
	const permissionDeniedLbl = useMsg(messages.permissionDenied)
	const noDeviceErrorLbl = useMsg(messages.noDeviceError)

	const [inputDeviceId, setInputDeviceId] = useLocalStorageState<string>(INPUT_DEVICE_KEY, '')
	const [outputDeviceId, setOutputDeviceId] = useLocalStorageState<string>(OUTPUT_DEVICE_KEY, '')
	const [inputDevices, setInputDevices] = useState<Device[]>([])
	const [outputDevices, setOutputDevices] = useState<Device[]>([])
	// Device labels (and sometimes the devices themselves) are hidden from `enumerateDevices()`
	// until access has been granted at least once — so an empty list on the first check doesn't
	// yet mean "no microphone", only that nothing's confirmed one way or the other.
	const [devicesChecked, setDevicesChecked] = useState(false)
	const [test, setTest] = useState<TestState>({ status: 'idle' })
	const [testStream, setTestStream] = useState<MediaStream | null>(null)

	const streamRef = useRef<MediaStream | null>(null)
	const recorderRef = useRef<MediaRecorder | null>(null)
	const chunksRef = useRef<Blob[]>([])
	const countdownRef = useRef(0)
	const audioElRef = useRef<HTMLAudioElement>(null)
	const objectUrlRef = useRef<string | null>(null)

	const level = useLevelMeter(testStream)

	const refreshDevices = useCallback(() => {
		navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
			setInputDevices(labelDevices(devices, 'audioinput', 'Microphone'))
			setOutputDevices(labelDevices(devices, 'audiooutput', 'Speaker'))
			setDevicesChecked(true)
		})
	}, [])

	useEffect(() => {
		refreshDevices()
		navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
		return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
	}, [refreshDevices])

	const stopStream = useCallback(() => {
		streamRef.current?.getTracks().forEach((t) => t.stop())
		streamRef.current = null
		setTestStream(null)
	}, [])

	const revokeUrl = useCallback(() => {
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current)
			objectUrlRef.current = null
		}
	}, [])

	// Release the mic and any recorded clip when the dialog closes.
	useEffect(() => {
		return () => {
			window.clearInterval(countdownRef.current)
			stopStream()
			revokeUrl()
		}
	}, [stopStream, revokeUrl])

	const finishRecording = useCallback(() => {
		window.clearInterval(countdownRef.current)
		if (recorderRef.current && recorderRef.current.state !== 'inactive') {
			recorderRef.current.stop()
		}
	}, [])

	const startTest = useCallback(async () => {
		revokeUrl()
		setTest({ status: 'requesting' })
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
			})
			streamRef.current = stream
			setTestStream(stream)
			refreshDevices()

			chunksRef.current = []
			const recorder = new MediaRecorder(stream)
			recorderRef.current = recorder
			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data)
			}
			recorder.onstop = () => {
				const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
				const url = URL.createObjectURL(blob)
				objectUrlRef.current = url
				stopStream()
				setTest({ status: 'recorded', url })
			}
			recorder.start()

			let secondsLeft = RECORD_SECONDS
			setTest({ status: 'recording', secondsLeft })
			countdownRef.current = window.setInterval(() => {
				secondsLeft -= 1
				if (secondsLeft <= 0) {
					finishRecording()
				} else {
					setTest({ status: 'recording', secondsLeft })
				}
			}, 1000)
		} catch {
			setTest({
				status: 'error',
				message: (navigator.mediaDevices ? permissionDeniedLbl : noDeviceErrorLbl) as string,
			})
		}
	}, [
		inputDeviceId,
		finishRecording,
		refreshDevices,
		revokeUrl,
		stopStream,
		permissionDeniedLbl,
		noDeviceErrorLbl,
	])

	const playBack = useCallback(
		async (url: string) => {
			const audioEl = audioElRef.current
			if (!audioEl) return
			if (SINK_ID_SUPPORTED && outputDeviceId) {
				try {
					await (audioEl as any).setSinkId(outputDeviceId)
				} catch {
					// Fall back to the default output device.
				}
			}
			audioEl.src = url
			setTest({ status: 'playing', url })
			try {
				await audioEl.play()
			} catch {
				setTest({ status: 'recorded', url })
			}
		},
		[outputDeviceId]
	)

	const handleAudioEnded = useCallback(() => {
		setTest((t) => (t.status === 'playing' ? { status: 'recorded', url: t.url } : t))
	}, [])

	const resetTest = useCallback(() => {
		revokeUrl()
		setTest({ status: 'idle' })
	}, [revokeUrl])

	return (
		<div className={styles.section}>
			<label className={styles.field}>
				<span className={styles.fieldLabel}>{microphoneLbl}</span>
				<select
					className={styles.select}
					value={inputDeviceId}
					onChange={(e) => setInputDeviceId(e.target.value)}
					data-testid="tla-audio-input-select"
				>
					<option value="">{systemDefaultLbl}</option>
					{inputDevices.map((d) => (
						<option key={d.deviceId} value={d.deviceId}>
							{d.label}
						</option>
					))}
				</select>
				{devicesChecked && inputDevices.length === 0 && (
					<div className={styles.help}>{noMicrophoneLbl}</div>
				)}
			</label>

			{SINK_ID_SUPPORTED ? (
				<label className={styles.field}>
					<span className={styles.fieldLabel}>{speakerLbl}</span>
					<select
						className={styles.select}
						value={outputDeviceId}
						onChange={(e) => setOutputDeviceId(e.target.value)}
						data-testid="tla-audio-output-select"
					>
						<option value="">{systemDefaultLbl}</option>
						{outputDevices.map((d) => (
							<option key={d.deviceId} value={d.deviceId}>
								{d.label}
							</option>
						))}
					</select>
				</label>
			) : (
				<div className={styles.help}>{sinkUnsupportedLbl}</div>
			)}

			<div className={styles.testArea}>
				{test.status === 'idle' && (
					<button
						type="button"
						className={styles.testButton}
						onClick={startTest}
						data-testid="tla-audio-test-start"
					>
						{testLbl}
					</button>
				)}

				{test.status === 'requesting' && (
					<button type="button" className={styles.testButton} disabled>
						{testLbl}
					</button>
				)}

				{test.status === 'recording' && (
					<>
						<div className={styles.meterRow}>
							<div className={styles.meter}>
								<div className={styles.meterFill} style={{ width: `${level * 100}%` }} />
							</div>
							<span className={styles.countdown}>
								{intl.formatMessage(messages.secondsLeft, { seconds: test.secondsLeft })}
							</span>
						</div>
						<div className={styles.recordingLabel}>{recordingLbl}</div>
						<button type="button" className={styles.linkButton} onClick={finishRecording}>
							{stopLbl}
						</button>
					</>
				)}

				{(test.status === 'recorded' || test.status === 'playing') && (
					<div className={styles.playbackRow}>
						<button
							type="button"
							className={styles.testButton}
							onClick={() => playBack(test.url)}
							disabled={test.status === 'playing'}
							data-testid="tla-audio-test-play"
						>
							{test.status === 'playing' ? playingLbl : playLbl}
						</button>
						<button type="button" className={styles.linkButton} onClick={resetTest}>
							{recordAgainLbl}
						</button>
					</div>
				)}

				{test.status === 'error' && (
					<>
						<div className={styles.errorText}>{test.message}</div>
						<button type="button" className={styles.linkButton} onClick={resetTest}>
							{recordAgainLbl}
						</button>
					</>
				)}
			</div>

			{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
			<audio ref={audioElRef} onEnded={handleAudioEnded} hidden />
		</div>
	)
}

/**
 * How the microphone behaves once the user is in a call: which gate opens it (a held key, or the
 * noise gate on its own), and how hard that gate works. Separate from the device pickers above
 * because these are about the room the user is in, not the hardware they have.
 */
export function TlaVoiceChatSettings() {
	const settings = useValue('voice-settings', () => getVoiceSettings().get(), [])
	const modeLbl = useMsg(messages.mode)
	const pushToTalkLbl = useMsg(messages.pushToTalk)
	const pushToTalkHelp = useMsg(messages.pushToTalkHelp)
	const openMicLbl = useMsg(messages.openMic)
	const openMicHelp = useMsg(messages.openMicHelp)
	const noiseSuppressionLbl = useMsg(messages.noiseSuppression)
	const noiseSuppressionHelp = useMsg(messages.noiseSuppressionHelp)
	const lowLbl = useMsg(messages.low)
	const mediumLbl = useMsg(messages.medium)
	const highLbl = useMsg(messages.high)
	const inputGainLbl = useMsg(messages.inputGain)

	const modes: { value: VoiceMode; label: string }[] = [
		{ value: 'push-to-talk', label: pushToTalkLbl },
		{ value: 'open', label: openMicLbl },
	]
	const levels: { value: NoiseSuppressionLevel; label: string }[] = [
		{ value: 'low', label: lowLbl },
		{ value: 'medium', label: mediumLbl },
		{ value: 'high', label: highLbl },
	]

	return (
		<div className={styles.section}>
			<div className={styles.field}>
				<span className={styles.fieldLabel}>{modeLbl}</span>
				<div className={styles.segmented} role="radiogroup" aria-label={modeLbl}>
					{modes.map((mode) => (
						<button
							key={mode.value}
							type="button"
							role="radio"
							aria-checked={settings.mode === mode.value}
							className={styles.segment}
							data-testid={`tla-voice-mode-${mode.value}`}
							onClick={() => updateVoiceSettings({ mode: mode.value })}
						>
							{mode.label}
						</button>
					))}
				</div>
				<div className={styles.help}>
					{settings.mode === 'push-to-talk' ? pushToTalkHelp : openMicHelp}
				</div>
			</div>

			<div className={styles.field}>
				<span className={styles.fieldLabel}>{noiseSuppressionLbl}</span>
				<div className={styles.segmented} role="radiogroup" aria-label={noiseSuppressionLbl}>
					{levels.map((level) => (
						<button
							key={level.value}
							type="button"
							role="radio"
							aria-checked={settings.noiseSuppression === level.value}
							className={styles.segment}
							data-testid={`tla-noise-gate-${level.value}`}
							onClick={() => updateVoiceSettings({ noiseSuppression: level.value })}
						>
							{level.label}
						</button>
					))}
				</div>
				<div className={styles.help}>{noiseSuppressionHelp}</div>
			</div>

			<label className={styles.field}>
				<span className={styles.fieldLabel}>{inputGainLbl}</span>
				<input
					type="range"
					min={0.5}
					max={3}
					step={0.1}
					value={settings.inputGain}
					className={styles.range}
					data-testid="tla-voice-input-gain"
					onChange={(e) => updateVoiceSettings({ inputGain: Number(e.target.value) })}
				/>
			</label>
		</div>
	)
}
