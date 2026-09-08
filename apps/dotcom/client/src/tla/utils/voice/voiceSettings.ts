import { atom, getFromLocalStorage, setInLocalStorage } from 'tldraw'

/**
 * How the microphone is gated.
 *
 * - `push-to-talk`: the mic is muted unless the talk key/button is held.
 * - `open`: the mic is live whenever voice is on, and the noise gate decides what gets through.
 */
export type VoiceMode = 'push-to-talk' | 'open'

/** How aggressively the noise gate closes. See NOISE_GATE_PRESETS for what each level means. */
export type NoiseSuppressionLevel = 'low' | 'medium' | 'high'

export interface VoiceSettings {
	mode: VoiceMode
	noiseSuppression: NoiseSuppressionLevel
	/** Extra gain applied after the gate, so a quiet mic can still reach a usable level. 0.5–3. */
	inputGain: number
}

const STORAGE_KEY = 'tldraw-dotcom:voice-settings-v1'

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	mode: 'push-to-talk',
	noiseSuppression: 'medium',
	inputGain: 1,
}

/**
 * Gate parameters per level, in dBFS for the thresholds and milliseconds for the timing.
 *
 * `open` is where speech starts getting through and `close` is where it stops; keeping them apart
 * (hysteresis) is what stops the gate chattering on and off during the quiet part of a word. The
 * hold keeps the gate open through the gaps inside a sentence, and the release fades it shut
 * instead of clipping the tail off. Higher levels raise both thresholds and shorten the hold, so
 * more of the room is cut at the cost of clipping quiet speech.
 */
export const NOISE_GATE_PRESETS: Record<
	NoiseSuppressionLevel,
	{ openDb: number; closeDb: number; holdMs: number; attackMs: number; releaseMs: number }
> = {
	low: { openDb: -55, closeDb: -60, holdMs: 400, attackMs: 5, releaseMs: 220 },
	medium: { openDb: -45, closeDb: -52, holdMs: 260, attackMs: 5, releaseMs: 160 },
	high: { openDb: -36, closeDb: -42, holdMs: 160, attackMs: 4, releaseMs: 110 },
}

function isVoiceSettings(value: unknown): value is VoiceSettings {
	if (!value || typeof value !== 'object') return false
	const v = value as VoiceSettings
	return (
		(v.mode === 'push-to-talk' || v.mode === 'open') &&
		(v.noiseSuppression === 'low' ||
			v.noiseSuppression === 'medium' ||
			v.noiseSuppression === 'high') &&
		typeof v.inputGain === 'number'
	)
}

function load(): VoiceSettings {
	const raw = getFromLocalStorage(STORAGE_KEY)
	if (raw) {
		try {
			const parsed = JSON.parse(raw)
			if (isVoiceSettings(parsed)) return parsed
		} catch {
			// fall through to defaults
		}
	}
	return DEFAULT_VOICE_SETTINGS
}

const settings = atom<VoiceSettings>('voiceSettings', load())

export function getVoiceSettings() {
	return settings
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>) {
	const next = { ...settings.get(), ...patch }
	setInLocalStorage(STORAGE_KEY, JSON.stringify(next))
	settings.set(next)
}
