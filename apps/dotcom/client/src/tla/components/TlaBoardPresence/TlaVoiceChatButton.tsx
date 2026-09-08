import classNames from 'classnames'
import { useCallback, useEffect } from 'react'
import { useToasts, useValue } from 'tldraw'
import { useBoardSession } from '../../providers/TlaBoardSessionProvider'
import { defineMessages, useMsg } from '../../utils/i18n'
import { getVoiceSettings } from '../../utils/voice/voiceSettings'
import styles from './presence.module.css'

/** Hold this to talk in push-to-talk mode. Space is taken by the canvas's hand-tool shortcut. */
const TALK_KEY = 'KeyV'

/** Fixed so repeated failures replace one another instead of stacking up. */
const VOICE_ERROR_TOAST_ID = 'uno-voice-chat-error'

const messages = defineMessages({
	turnOn: { defaultMessage: 'Join voice chat' },
	turnOff: { defaultMessage: 'Leave voice chat' },
	starting: { defaultMessage: 'Starting…' },
	errorTitle: { defaultMessage: "Voice chat couldn't start" },
	denied: { defaultMessage: 'Microphone access was denied. Allow it in your browser settings.' },
	noDevice: { defaultMessage: 'No microphone was found. Check that one is plugged in.' },
	inUse: {
		defaultMessage: 'The microphone is being used by another app. Close it and try again.',
	},
	insecure: {
		defaultMessage:
			'Browsers only allow microphone access over https or on localhost. Open the app on one of those.',
	},
	failed: { defaultMessage: 'Something went wrong. Try again.' },
	holdToTalk: { defaultMessage: 'Hold to talk (V)' },
	talking: { defaultMessage: 'Talking' },
	openMic: { defaultMessage: 'Open mic' },
})

/**
 * The voice chat control in the editor header: one button to join or leave, and — in push-to-talk
 * mode — a second one to hold while talking. The talk button doubles as the local speaking
 * indicator, so the user can see their own gate opening and closing rather than guessing whether
 * the noise gate ate the start of their sentence.
 */
export function TlaVoiceChatButton() {
	const {
		voiceStatus,
		voiceError,
		isSelfSpeaking,
		isTalkHeld,
		startVoice,
		stopVoice,
		setTalkHeld,
		micLevel,
	} = useBoardSession()
	const { addToast, removeToast } = useToasts()
	const mode = useValue('voice-mode', () => getVoiceSettings().get().mode, [])

	const turnOnLbl = useMsg(messages.turnOn)
	const turnOffLbl = useMsg(messages.turnOff)
	const startingLbl = useMsg(messages.starting)
	const errorTitleLbl = useMsg(messages.errorTitle)
	const deniedLbl = useMsg(messages.denied)
	const noDeviceLbl = useMsg(messages.noDevice)
	const inUseLbl = useMsg(messages.inUse)
	const insecureLbl = useMsg(messages.insecure)
	const failedLbl = useMsg(messages.failed)
	const holdToTalkLbl = useMsg(messages.holdToTalk)
	const talkingLbl = useMsg(messages.talking)
	const openMicLbl = useMsg(messages.openMic)

	const isOn = voiceStatus === 'on'
	const isPushToTalk = mode === 'push-to-talk'

	// The keyboard half of push-to-talk. Bound on the window rather than the button so the user
	// doesn't have to keep focus on a control while drawing, which is the whole point of the mode.
	useEffect(() => {
		if (!isOn || !isPushToTalk) return
		const isTypingTarget = (target: EventTarget | null) => {
			const el = target as HTMLElement | null
			if (!el) return false
			return (
				el.isContentEditable ||
				el.tagName === 'INPUT' ||
				el.tagName === 'TEXTAREA' ||
				el.tagName === 'SELECT'
			)
		}
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.code !== TALK_KEY || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
			if (isTypingTarget(e.target)) return
			setTalkHeld(true)
		}
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code !== TALK_KEY) return
			setTalkHeld(false)
		}
		// Losing the window mid-hold would otherwise leave the mic open with no key to release.
		const onBlur = () => setTalkHeld(false)
		window.addEventListener('keydown', onKeyDown)
		window.addEventListener('keyup', onKeyUp)
		window.addEventListener('blur', onBlur)
		return () => {
			window.removeEventListener('keydown', onKeyDown)
			window.removeEventListener('keyup', onKeyUp)
			window.removeEventListener('blur', onBlur)
			setTalkHeld(false)
		}
	}, [isOn, isPushToTalk, setTalkHeld])

	const toggle = useCallback(() => {
		if (isOn || voiceStatus === 'starting') stopVoice()
		else startVoice()
	}, [isOn, voiceStatus, startVoice, stopVoice])

	// A failed attempt leaves the button off, so the reason has to be said somewhere the user will
	// see it. The fixed id means a second failed attempt replaces the first message rather than
	// stacking another copy of it — clicking a broken microphone button five times is one problem,
	// not five.
	const descriptions: Record<NonNullable<typeof voiceError>, string> = {
		denied: deniedLbl,
		'no-device': noDeviceLbl,
		'in-use': inUseLbl,
		insecure: insecureLbl,
		failed: failedLbl,
	}
	useEffect(() => {
		if (!voiceError) return
		addToast({
			id: VOICE_ERROR_TOAST_ID,
			severity: 'error',
			title: errorTitleLbl,
			description: descriptions[voiceError],
		})
		// `descriptions` is rebuilt every render; the error itself is what should trigger a message.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [voiceError, addToast, errorTitleLbl])

	// Clear the message once voice is actually running, so a stale failure isn't left on screen.
	useEffect(() => {
		if (isOn) removeToast(VOICE_ERROR_TOAST_ID)
	}, [isOn, removeToast])

	const toggleLabel = isOn ? turnOffLbl : voiceStatus === 'starting' ? startingLbl : turnOnLbl

	return (
		<div className={styles.voiceControls}>
			<button
				type="button"
				className={classNames(styles.voiceButton, { [styles.voiceButtonOn]: isOn })}
				onClick={toggle}
				aria-pressed={isOn}
				aria-label={toggleLabel}
				title={toggleLabel}
				data-testid="tla-voice-toggle"
			>
				<MicGlyph isMuted={!isOn} />
				{isOn && (
					<span
						className={styles.voiceLevel}
						style={{ transform: `scaleX(${Math.max(0.04, micLevel)})` }}
						aria-hidden
					/>
				)}
			</button>

			{isOn && isPushToTalk && (
				<button
					type="button"
					className={classNames(styles.talkButton, { [styles.talkButtonHeld]: isTalkHeld })}
					aria-label={holdToTalkLbl}
					title={holdToTalkLbl}
					data-testid="tla-voice-talk"
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture(e.pointerId)
						setTalkHeld(true)
					}}
					onPointerUp={() => setTalkHeld(false)}
					onPointerCancel={() => setTalkHeld(false)}
				>
					{isTalkHeld ? talkingLbl : holdToTalkLbl}
				</button>
			)}

			{isOn && !isPushToTalk && (
				<span
					className={classNames(styles.openMicBadge, {
						[styles.openMicBadgeActive]: isSelfSpeaking,
					})}
					data-testid="tla-voice-open-mic"
					data-speaking={isSelfSpeaking}
				>
					{isSelfSpeaking ? talkingLbl : openMicLbl}
				</span>
			)}
		</div>
	)
}

/** No microphone in the shared icon set, so it's inline. Sized to match TldrawUiIcon's small. */
function MicGlyph({ isMuted }: { isMuted: boolean }) {
	return (
		<svg
			className={styles.voiceButtonGlyph}
			viewBox="0 0 18 18"
			width="18"
			height="18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<rect x="6.25" y="2" width="5.5" height="9" rx="2.75" />
			<path d="M4 8.25a5 5 0 0 0 10 0" />
			<path d="M9 13.25V16" />
			{isMuted && <path d="M3 15 15 3" />}
		</svg>
	)
}
