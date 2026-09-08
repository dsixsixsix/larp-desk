import { atom, uniqueId } from 'tldraw'

export interface ActivityLogEntry {
	id: string
	message: string
	time: number
	user: string | null
}

const MAX_ENTRIES = 100

/** In-memory only — the log is a "what just happened" aid, not a persisted audit trail. */
const entries = atom<ActivityLogEntry[]>('activityLogEntries', [])

export function getActivityLogEntries() {
	return entries
}

export function pushActivityLogEntry(message: string, user: string | null) {
	entries.update((prev) =>
		[{ id: uniqueId(), message, time: Date.now(), user }, ...prev].slice(0, MAX_ENTRIES)
	)
}

export function clearActivityLog() {
	entries.set([])
}
