/** Number of swatches defined as `--uno-board-N` in tla.css. */
const BOARD_ACCENT_COUNT = 7

/**
 * A board's swatch colour, derived from its id so it is stable across sessions,
 * devices, and renames — the colour is a recognition aid in the sidebar, so it
 * must not move when the board's name or position does.
 *
 * Returns a CSS variable reference, not a colour, so the palette stays defined in
 * one place and can retheme per colour mode.
 */
export function getBoardAccentVar(fileId: string) {
	// djb2. Cheap, and spreads adjacent ids (which share long prefixes) across
	// different buckets far better than summing char codes does.
	let hash = 5381
	for (let i = 0; i < fileId.length; i++) {
		hash = ((hash << 5) + hash + fileId.charCodeAt(i)) | 0
	}
	return `var(--uno-board-${(Math.abs(hash) % BOARD_ACCENT_COUNT) + 1})`
}
