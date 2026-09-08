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

export function getAudioPeaks(url: string): Promise<Float32Array | null> {
	const cached = peaksCache.get(url)
	if (cached) return cached

	const promise = decodePeaks(url).catch(() => null)
	peaksCache.set(url, promise)
	return promise
}

async function decodePeaks(url: string): Promise<Float32Array | null> {
	const AudioContextCtor =
		window.AudioContext ??
		(window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
	if (!AudioContextCtor) return null

	const response = await fetch(url)
	if (!response.ok) return null
	const arrayBuffer = await response.arrayBuffer()

	const context = new AudioContextCtor()
	try {
		const audioBuffer = await context.decodeAudioData(arrayBuffer)
		return computePeaks(audioBuffer)
	} finally {
		// Safari caps the number of live contexts, and we only ever wanted the decoder.
		context.close()
	}
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
