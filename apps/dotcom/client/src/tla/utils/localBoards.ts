import { atom, getFromLocalStorage, setInLocalStorage, uniqueId } from 'tldraw'
import { getScratchPersistenceKey } from '../../utils/scratch-persistence-key'

export interface LocalWorkspace {
	id: string
	name: string
}

/** `id` doubles as the tldraw `persistenceKey` for this board's own store — boards don't share
 *  documents, so there's no need for a separate id to look one up by. */
export interface LocalBoard {
	id: string
	name: string
	workspaceId: string
}

interface LocalBoardsState {
	workspaces: LocalWorkspace[]
	boards: LocalBoard[]
	currentBoardId: string
}

const STORAGE_KEY = 'tldraw-dotcom:local-boards-v1'

/** Mirrors `STORE_PREFIX` in the editor's LocalIndexedDb — a board's document database is named
 *  from its persistence key, which for local boards is the board id. */
const TLDRAW_DB_PREFIX = 'TLDRAW_DOCUMENT_v2'
/** The editor keeps its own list of databases it has opened, used by `hardReset`. Deleting a
 *  board's database without pruning this leaves an entry pointing at nothing. */
const TLDRAW_DB_NAME_INDEX_KEY = 'TLDRAW_DB_NAME_INDEX_v2'

function isValidState(value: unknown): value is LocalBoardsState {
	if (!value || typeof value !== 'object') return false
	const s = value as LocalBoardsState
	return (
		Array.isArray(s.workspaces) &&
		s.workspaces.length > 0 &&
		Array.isArray(s.boards) &&
		s.boards.length > 0 &&
		typeof s.currentBoardId === 'string' &&
		s.boards.some((b) => b.id === s.currentBoardId)
	)
}

/** First run (or corrupted data): wrap the existing scratch board as the first board of a default
 *  workspace, reusing its persistence key as the board id — so existing on-disk content becomes
 *  "Board 1" for free instead of needing a data migration. */
function bootstrapState(): LocalBoardsState {
	const workspace: LocalWorkspace = { id: uniqueId(), name: 'My workspace' }
	const board: LocalBoard = {
		id: getScratchPersistenceKey(),
		name: 'Board 1',
		workspaceId: workspace.id,
	}
	return { workspaces: [workspace], boards: [board], currentBoardId: board.id }
}

function loadInitialState(): LocalBoardsState {
	const raw = getFromLocalStorage(STORAGE_KEY)
	if (raw) {
		try {
			const parsed = JSON.parse(raw)
			if (isValidState(parsed)) return parsed
		} catch {
			// fall through to bootstrap
		}
	}
	return bootstrapState()
}

const state = atom<LocalBoardsState>('localBoardsState', loadInitialState())

function persist(next: LocalBoardsState) {
	setInLocalStorage(STORAGE_KEY, JSON.stringify(next))
	state.set(next)
}

export function getLocalBoardsState() {
	return state
}

export function getCurrentBoard(): LocalBoard {
	const s = state.get()
	return s.boards.find((b) => b.id === s.currentBoardId) ?? s.boards[0]
}

export function getCurrentWorkspace(): LocalWorkspace {
	const s = state.get()
	const board = getCurrentBoard()
	return s.workspaces.find((w) => w.id === board.workspaceId) ?? s.workspaces[0]
}

export function getBoardsForWorkspace(workspaceId: string): LocalBoard[] {
	return state.get().boards.filter((b) => b.workspaceId === workspaceId)
}

export function switchBoard(boardId: string) {
	const s = state.get()
	if (boardId === s.currentBoardId || !s.boards.some((b) => b.id === boardId)) return
	persist({ ...s, currentBoardId: boardId })
}

/** Switches to a workspace's most-recently-created board — workspaces always have at least one
 *  (see createWorkspace), so this never has to fall back to creating one on the fly. */
export function switchWorkspace(workspaceId: string) {
	const s = state.get()
	const boards = s.boards.filter((b) => b.workspaceId === workspaceId)
	const target = boards[boards.length - 1]
	if (!target || target.id === s.currentBoardId) return
	persist({ ...s, currentBoardId: target.id })
}

export function createWorkspace(name: string): string {
	const s = state.get()
	const workspace: LocalWorkspace = { id: uniqueId(), name }
	const board: LocalBoard = {
		id: 'tla-board-' + uniqueId(),
		name: 'Board 1',
		workspaceId: workspace.id,
	}
	persist({
		workspaces: [...s.workspaces, workspace],
		boards: [...s.boards, board],
		currentBoardId: board.id,
	})
	return board.id
}

export function createBoard(name: string, workspaceId: string): string {
	const s = state.get()
	const board: LocalBoard = { id: 'tla-board-' + uniqueId(), name, workspaceId }
	persist({ ...s, boards: [...s.boards, board], currentBoardId: board.id })
	return board.id
}

/**
 * Opens a board by id, adding it to this browser's list if it isn't there yet — how someone joins
 * a board from a shared link (see getBoardInviteUrl).
 *
 * The board id is also the persistence key, so a joiner starts with an empty document under that
 * key: what is shared is the live session on it — who is here, and voice — not its contents. An
 * id already in the list is just opened, so following the same link twice doesn't make a second
 * copy of a board someone is already using.
 */
export function adoptBoard(boardId: string, name?: string): void {
	const trimmedId = boardId.trim()
	if (!trimmedId) return

	const s = state.get()
	const existing = s.boards.find((b) => b.id === trimmedId)
	if (existing) {
		if (existing.id !== s.currentBoardId) persist({ ...s, currentBoardId: existing.id })
		return
	}

	const board: LocalBoard = {
		id: trimmedId,
		name: name?.trim() || 'Shared board',
		// Joined boards land in the workspace the user is currently in: they have no workspace of
		// their own, and inventing one would leave an orphan behind after the visit.
		workspaceId: getCurrentWorkspace().id,
	}
	persist({ ...s, boards: [...s.boards, board], currentBoardId: board.id })
}

/** The link that opens this board in someone else's browser. See adoptBoard for what it shares. */
export function getBoardInviteUrl(origin: string = window.location.origin): string {
	const board = getCurrentBoard()
	const params = new URLSearchParams({ board: board.id, name: board.name })
	return `${origin}/?${params.toString()}`
}

export function renameBoard(boardId: string, name: string) {
	const trimmed = name.trim()
	if (!trimmed) return
	const s = state.get()
	persist({ ...s, boards: s.boards.map((b) => (b.id === boardId ? { ...b, name: trimmed } : b)) })
}

export function renameWorkspace(workspaceId: string, name: string) {
	const trimmed = name.trim()
	if (!trimmed) return
	const s = state.get()
	persist({
		...s,
		workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, name: trimmed } : w)),
	})
}

/**
 * Drops a board's document database.
 *
 * The board being deleted may still be the one the editor has open — the caller switches away
 * first, but React unmounts (and so closes the IndexedDB connection) on the next commit, after
 * this has already been called. `deleteDatabase` handles that itself: it fires `blocked` and then
 * completes once the last connection closes, so the delete is left to resolve on its own rather
 * than awaited.
 */
function deleteBoardData(boardId: string) {
	const dbName = TLDRAW_DB_PREFIX + boardId
	try {
		indexedDB.deleteDatabase(dbName)
	} catch {
		// A browser with storage disabled has nothing to delete.
	}
	try {
		const raw = getFromLocalStorage(TLDRAW_DB_NAME_INDEX_KEY)
		const names = raw ? JSON.parse(raw) : []
		if (Array.isArray(names)) {
			setInLocalStorage(TLDRAW_DB_NAME_INDEX_KEY, JSON.stringify(names.filter((n) => n !== dbName)))
		}
	} catch {
		// A malformed index isn't worth failing the delete over.
	}
}

/** Whether `deleteBoard` would be allowed. The app has no empty state, so the last board stays. */
export function canDeleteBoard(boardId: string): boolean {
	const s = state.get()
	return s.boards.length > 1 && s.boards.some((b) => b.id === boardId)
}

/**
 * Deletes a board and its content. Deleting a workspace's last board deletes the workspace too —
 * an empty workspace can't be navigated to (see switchWorkspace) and would be a dead row in the
 * switcher.
 */
export function deleteBoard(boardId: string) {
	const s = state.get()
	if (!canDeleteBoard(boardId)) return
	const board = s.boards.find((b) => b.id === boardId)
	if (!board) return

	const boards = s.boards.filter((b) => b.id !== boardId)
	const workspaceIsEmpty = !boards.some((b) => b.workspaceId === board.workspaceId)
	const workspaces = workspaceIsEmpty
		? s.workspaces.filter((w) => w.id !== board.workspaceId)
		: s.workspaces

	// Prefer a sibling in the same workspace so deleting one board of several doesn't also move
	// the user to a different workspace.
	const sibling = boards.find((b) => b.workspaceId === board.workspaceId)
	const currentBoardId = s.currentBoardId === boardId ? (sibling ?? boards[0]).id : s.currentBoardId

	persist({ workspaces, boards, currentBoardId })
	deleteBoardData(boardId)
}

/** Whether `deleteWorkspace` would be allowed. The app has no empty state, so the last one stays. */
export function canDeleteWorkspace(workspaceId: string): boolean {
	const s = state.get()
	return s.workspaces.length > 1 && s.workspaces.some((w) => w.id === workspaceId)
}

/** Deletes a workspace along with every board in it, and all of their content. */
export function deleteWorkspace(workspaceId: string) {
	const s = state.get()
	if (!canDeleteWorkspace(workspaceId)) return

	const removed = s.boards.filter((b) => b.workspaceId === workspaceId)
	const boards = s.boards.filter((b) => b.workspaceId !== workspaceId)
	if (boards.length === 0) return

	const currentBoardId = boards.some((b) => b.id === s.currentBoardId)
		? s.currentBoardId
		: boards[0].id

	persist({
		workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
		boards,
		currentBoardId,
	})
	for (const board of removed) deleteBoardData(board.id)
}

/**
 * Clears every board, its content, and the local boards state itself.
 *
 * The signed-out app has no account to sign out of, so this is what "start over" means: without
 * it the only way to get rid of local work is the browser's own clear-site-data. The caller is
 * expected to reload afterwards — the state atom is left as it was so nothing re-persists it on
 * the way out.
 */
export function deleteAllLocalBoards() {
	for (const board of state.get().boards) deleteBoardData(board.id)
	setInLocalStorage(STORAGE_KEY, '')
	try {
		window.localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Storage disabled; there was nothing to clear.
	}
}
