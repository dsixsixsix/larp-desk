import { fetch } from 'tldraw'

/**
 * Peak amplitudes for an audio file, for drawing a waveform.
 *
 * Decoding needs the whole file in memory, so results are cached per URL and shared between the
 * card and the player — reopening a track doesn't download or decode it twice. Failure is not an
 * error state: the player falls back to a plain progress bar, so a CORS-blocked or undecodable
 * file still plays.
 */

const peaksCache = new Map<string, Promise<Float32Array | null>>()

/** Enough detail to read as a waveform at the player's width, cheap enough to draw every frame. */
export const WAVEFORM_BUCKETS = 160

/**
 * The largest file we will pull in to draw a waveform for.
 *
 * Assets on a shared board are fetched by everyone who opens it, so the cost of this is paid by
 * every viewer, not by whoever uploaded the file. The server refuses uploads above its own ceiling,
 * but an asset src is just a URL and nothing stops one pointing somewhere else.
 */
const MAX_PEAKS_SOURCE_BYTES = 20 * 1024 * 1024

/**
 * The rate we decode at, which decides how much memory the decoded audio takes.
 *
 * `decodeAudioData` resamples to its context's rate, and at 44.1kHz a few minutes of stereo is
 * hundreds of megabytes of float32 — enough to take the tab down, for a drawing that is 160 bars
 * wide. Nothing above a few hundred hertz survives the bucketing anyway.
 */
const PEAKS_SAMPLE_RATE = 8000

export function getAudioPeaks(url: string): Promise<Float32Array | null> {
	const cached = peaksCache.get(url)
	if (cached) return cached

	const promise = decodePeaks(url).catch(() => null)
	peaksCache.set(url, promise)
	return promise
}

async function decodePeaks(url: string): Promise<Float32Array | null> {
	const OfflineAudioContextCtor =
		window.OfflineAudioContext ??
		(window as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
	if (!OfflineAudioContextCtor) return null

	const response = await fetch(url)
	if (!response.ok) return null

	const declaredLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PEAKS_SOURCE_BYTES) return null

	const arrayBuffer = await response.arrayBuffer()
	// A response can arrive without a content-length, or with one that understates it.
	if (arrayBuffer.byteLength > MAX_PEAKS_SOURCE_BYTES) return null

	// Offline rather than live: this is a decoder, and its sample rate is what keeps the decoded
	// buffer small. The length is a placeholder — decodeAudioData sizes its own output.
	const context = new OfflineAudioContextCtor(1, 1, PEAKS_SAMPLE_RATE)
	const audioBuffer = await context.decodeAudioData(arrayBuffer)
	return computePeaks(audioBuffer)
}

function computePeaks(audioBuffer: AudioBuffer): Float32Array {
	const channel = audioBuffer.getChannelData(0)
	const bucketSize = Math.max(1, Math.floor(channel.length / WAVEFORM_BUCKETS))
	const peaks = new Float32Array(WAVEFORM_BUCKETS)

	let max = 0
	for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
		const start = i * bucketSize
		const end = Math.min(channel.length, start + bucketSize)
		// RMS rather than peak: a single clipped sample shouldn't make a quiet passage look loud.
		let sum = 0
		for (let j = start; j < end; j++) {
			sum += channel[j] * channel[j]
		}
		const rms = Math.sqrt(sum / Math.max(1, end - start))
		peaks[i] = rms
		if (rms > max) max = rms
	}

	// Normalise, so a quietly mastered track still fills the waveform.
	if (max > 0) {
		for (let i = 0; i < peaks.length; i++) peaks[i] /= max
	}
	return peaks
}
