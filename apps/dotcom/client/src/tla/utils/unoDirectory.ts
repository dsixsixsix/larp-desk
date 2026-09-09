import {
	UNO_SESSION_QUERY_PARAM,
	UnoDirectory,
	UnoDirectoryBoard,
	UnoInviteInfo,
	UnoInviteScope,
	UnoInviteSummary,
	UnoMemberSummary,
} from '@tldraw/dotcom-shared'
import { atom, fetch, getFromLocalStorage, setInLocalStorage } from 'tldraw'
import { API_SERVER } from '../../utils/config'

/**
 * The client half of the invite-only directory (see UnoDirectoryDurableObject in the sync worker).
 *
 * Boards themselves are still local documents — a board's contents live in this browser's own
 * IndexedDB under the board id — but *which* boards exist and who may open them is the server's
 * answer, not this browser's. That is the whole difference from the older local-only board list:
 * a link no longer grants access, an invite does.
 */

const SESSION_STORAGE_KEY = 'tldraw-dotcom:uno-session'
const CURRENT_BOARD_STORAGE_KEY = 'tldraw-dotcom:uno-current-board'
/** The board ids this browser has seen, so ones it loses access to can have their data dropped. */
const KNOWN_BOARDS_STORAGE_KEY = 'tldraw-dotcom:uno-known-boards'

/** Mirrors `STORE_PREFIX` in the editor's LocalIndexedDb — a board's database is named from its
 *  persistence key, which is the board id. */
const TLDRAW_DB_PREFIX = 'TLDRAW_DOCUMENT_v2'
/** The editor keeps its own list of databases it has opened, used by `hardReset`. Deleting a
 *  board's database without pruning this leaves an entry pointing at nothing. */
const TLDRAW_DB_NAME_INDEX_KEY = 'TLDRAW_DB_NAME_INDEX_v2'

export type UnoSessionState =
	| { status: 'loading' }
	/** No session, or one the server no longer knows: the join screen, or the "ask for a link" wall. */
	| { status: 'signed-out' }
	| { status: 'ready'; directory: UnoDirectory }

const sessionState = atom<UnoSessionState>('unoSession', { status: 'loading' })
const currentBoardId = atom<string | null>(
	'unoCurrentBoardId',
	getFromLocalStorage(CURRENT_BOARD_STORAGE_KEY) || null
)

export function getUnoSessionState() {
	return sessionState
}

export function getUnoCurrentBoardId() {
	return currentBoardId
}

function getSessionToken(): string {
	return getFromLocalStorage(SESSION_STORAGE_KEY) || ''
}

function setSessionToken(token: string | null) {
	setInLocalStorage(SESSION_STORAGE_KEY, token ?? '')
}

/** The token the presence socket sends, which cannot use an Authorization header. */
export function getPresenceSessionParam(): string {
	return `${UNO_SESSION_QUERY_PARAM}=${encodeURIComponent(getSessionToken())}`
}

async function api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }> {
	let response: Response
	try {
		response = await fetch(`${API_SERVER}${path}`, {
			method: init.method ?? 'GET',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${getSessionToken()}`,
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		})
	} catch {
		// Offline, or the worker is unreachable. Deliberately not a status, so callers can tell a
		// network failure from a refusal and leave the session alone.
		return { ok: false, status: 0, error: 'network' }
	}
	if (!response.ok) {
		const body = await response.json().catch(() => null)
		const error = body && typeof body === 'object' ? ((body as any).error ?? 'error') : 'error'
		return { ok: false, status: response.status, error }
	}
	return { ok: true, value: (await response.json()) as T }
}

function allBoards(directory: UnoDirectory): UnoDirectoryBoard[] {
	return directory.workspaces.flatMap((w) => w.boards)
}

/**
 * Drops a board's document database.
 *
 * `deleteDatabase` fires `blocked` and then completes once the last connection closes, so it is
 * left to resolve on its own rather than awaited: the editor for the board being deleted only
 * closes its connection on the next React commit, after this has already been called.
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

/**
 * Deletes the local contents of boards this browser can no longer open.
 *
 * Being removed from a board has to take the copy with it, or "removed" would only mean "no longer
 * listed" for someone who already has the document on disk. Only ids this browser had been given
 * before are considered, so nothing else in IndexedDB is ever touched — and this runs only after a
 * directory load that actually succeeded, so a failed request can't be read as "access to
 * everything was revoked".
 */
function pruneRevokedBoards(directory: UnoDirectory) {
	const current = new Set(allBoards(directory).map((b) => b.id))
	let known: string[] = []
	try {
		const raw = getFromLocalStorage(KNOWN_BOARDS_STORAGE_KEY)
		const parsed = raw ? JSON.parse(raw) : []
		if (Array.isArray(parsed)) known = parsed.filter((id): id is string => typeof id === 'string')
	} catch {
		// Treated as "nothing known yet": the worst case is a stale database nobody can open.
	}
	for (const id of known) if (!current.has(id)) deleteBoardData(id)
	setInLocalStorage(KNOWN_BOARDS_STORAGE_KEY, JSON.stringify([...current]))
}

function applyDirectory(directory: UnoDirectory) {
	pruneRevokedBoards(directory)
	sessionState.set({ status: 'ready', directory })
	const boards = allBoards(directory)
	const current = currentBoardId.get()
	if (!current || !boards.some((b) => b.id === current)) {
		setCurrentBoardId(boards[0]?.id ?? null)
	}
}

export function setCurrentBoardId(boardId: string | null) {
	currentBoardId.set(boardId)
	setInLocalStorage(CURRENT_BOARD_STORAGE_KEY, boardId ?? '')
}

/**
 * Loads what this browser's session is allowed to see. A network failure leaves the previous state
 * alone rather than signing the user out — a flaky connection should not empty the sidebar.
 */
export async function loadUnoDirectory(): Promise<void> {
	if (!getSessionToken()) {
		sessionState.set({ status: 'signed-out' })
		return
	}
	const result = await api<UnoDirectory>('/uno/directory')
	if (result.ok) {
		applyDirectory(result.value)
		return
	}
	if (result.status === 401) {
		setSessionToken(null)
		sessionState.set({ status: 'signed-out' })
		return
	}
	if (sessionState.get().status === 'loading') sessionState.set({ status: 'signed-out' })
}

export async function getUnoInviteInfo(token: string): Promise<UnoInviteInfo | null> {
	const result = await api<UnoInviteInfo>(`/uno/invite/${encodeURIComponent(token)}`)
	return result.ok ? result.value : null
}

export type UnoJoinError = 'not-found' | 'reserved' | 'network' | 'error'

/** Redeems an invite link under a name and email, and signs this browser in. */
export async function acceptUnoInvite(
	token: string,
	name: string,
	email: string
): Promise<{ ok: true } | { ok: false; error: UnoJoinError }> {
	const result = await api<{ sessionToken: string; directory: UnoDirectory }>(
		`/uno/invite/${encodeURIComponent(token)}/accept`,
		{ method: 'POST', body: { name, email } }
	)
	if (!result.ok) {
		return { ok: false, error: (result.status === 0 ? 'network' : result.error) as UnoJoinError }
	}
	setSessionToken(result.value.sessionToken)
	applyDirectory(result.value.directory)
	return { ok: true }
}

export type UnoAdminLoginError = 'denied' | 'locked' | 'network' | 'error'

export async function signInUnoAdmin(
	secret: string
): Promise<{ ok: true } | { ok: false; error: UnoAdminLoginError }> {
	const result = await api<{ sessionToken: string; directory: UnoDirectory }>('/uno/admin/login', {
		method: 'POST',
		body: { secret },
	})
	if (!result.ok) {
		return {
			ok: false,
			error: (result.status === 0 ? 'network' : result.error) as UnoAdminLoginError,
		}
	}
	setSessionToken(result.value.sessionToken)
	applyDirectory(result.value.directory)
	return { ok: true }
}

export async function signOutUno(): Promise<void> {
	await api('/uno/signout', { method: 'POST' })
	setSessionToken(null)
	sessionState.set({ status: 'signed-out' })
	setCurrentBoardId(null)
}

// ------------------------------------------------------------------ admin actions
//
// Each of these returns the directory the server produced, so the sidebar is never rebuilt from a
// guess about what the mutation did.

async function adminDirectoryAction(
	path: string,
	init: { method?: string; body?: unknown }
): Promise<boolean> {
	const result = await api<UnoDirectory>(path, init)
	if (!result.ok) return false
	applyDirectory(result.value)
	return true
}

export function createUnoWorkspace(name: string) {
	return adminDirectoryAction('/uno/admin/workspaces', { method: 'POST', body: { name } })
}

export function createUnoBoard(workspaceId: string, name: string) {
	return adminDirectoryAction('/uno/admin/boards', { method: 'POST', body: { workspaceId, name } })
}

export function renameUnoWorkspace(workspaceId: string, name: string) {
	return adminDirectoryAction(`/uno/admin/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
		method: 'POST',
		body: { name },
	})
}

export function renameUnoBoard(boardId: string, name: string) {
	return adminDirectoryAction(`/uno/admin/boards/${encodeURIComponent(boardId)}/rename`, {
		method: 'POST',
		body: { name },
	})
}

export function deleteUnoBoard(boardId: string) {
	return adminDirectoryAction(`/uno/admin/boards/${encodeURIComponent(boardId)}`, {
		method: 'DELETE',
	})
}

export function deleteUnoWorkspace(workspaceId: string) {
	return adminDirectoryAction(`/uno/admin/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: 'DELETE',
	})
}

/** The full link to send someone, from a freshly minted token. */
export async function createUnoInviteUrl(
	scope: UnoInviteScope,
	scopeId: string
): Promise<string | null> {
	const result = await api<{ token: string }>('/uno/admin/invites', {
		method: 'POST',
		body: { scope, scopeId },
	})
	if (!result.ok) return null
	return getUnoInviteUrl(result.value.token)
}

export function getUnoInviteUrl(token: string, origin: string = window.location.origin): string {
	return `${origin}/join/${token}`
}

export async function listUnoInvites(): Promise<UnoInviteSummary[]> {
	const result = await api<UnoInviteSummary[]>('/uno/admin/invites')
	return result.ok ? result.value : []
}

export async function revokeUnoInvite(token: string): Promise<boolean> {
	const result = await api(`/uno/admin/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })
	return result.ok
}

export async function listUnoMembers(): Promise<UnoMemberSummary[] | null> {
	const result = await api<UnoMemberSummary[]>('/uno/admin/members')
	return result.ok ? result.value : null
}

export async function removeUnoMember(
	userId: string,
	scope: UnoInviteScope,
	scopeId: string
): Promise<UnoMemberSummary[] | null> {
	const result = await api<UnoMemberSummary[]>('/uno/admin/members/remove', {
		method: 'POST',
		body: { userId, scope, scopeId },
	})
	return result.ok ? result.value : null
}

export async function removeUnoUser(userId: string): Promise<UnoMemberSummary[] | null> {
	const result = await api<UnoMemberSummary[]>('/uno/admin/users/remove', {
		method: 'POST',
		body: { userId },
	})
	return result.ok ? result.value : null
}

/** Changes this browser's own display name. The email is fixed: it is what two invites match on. */
export async function updateUnoOwnName(name: string): Promise<boolean> {
	return adminDirectoryAction('/uno/profile', { method: 'POST', body: { name } })
}

/**
 * Signs out and deletes every board this browser holds.
 *
 * The signed-out app has no account to sign out of *to*, so this is what "leave this machine
 * clean" means: without it, the documents stay in IndexedDB for whoever sits down next. The caller
 * reloads afterwards, which puts the invite wall back up.
 */
export async function resetUnoLocalData(): Promise<void> {
	const session = sessionState.get()
	if (session.status === 'ready') {
		for (const board of allBoards(session.directory)) deleteBoardData(board.id)
	}
	setInLocalStorage(KNOWN_BOARDS_STORAGE_KEY, '[]')
	await signOutUno()
}
