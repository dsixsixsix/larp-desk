import {
	UNO_ADMIN_EMAIL,
	UnoDirectory,
	UnoDirectoryUser,
	UnoDirectoryWorkspace,
	UnoInviteInfo,
	UnoInviteScope,
	UnoInviteSummary,
	UnoMemberSummary,
} from '@tldraw/dotcom-shared'

// The SQL behind the invite-only directory, kept apart from UnoDirectoryDurableObject so it can be
// run against a real SQLite database in a test — otherwise these statements would only ever
// execute in production. Same arrangement, and for the same reason, as mcpClusterIndexStorage.ts.

/** The subset of Cloudflare's `SqlStorage` these statements need. */
export interface UnoDirectorySql {
	exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] }
}

/**
 * A session is left valid until it is used this long after its last request. Long, because the
 * only way back in is another invite link from the admin, and expiring someone mid-project to no
 * benefit is worse than the marginal risk of a stale token on a browser they still own.
 */
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000

/**
 * Membership is two tables rather than one polymorphic one: a workspace membership and a board
 * membership are read on different paths (the workspace one has to fan out to boards created after
 * it was granted) and a single table would need the scope in every join anyway.
 *
 * Everything a board or workspace owns is deleted with it — `ON DELETE CASCADE` is not enabled in
 * Durable Object SQLite by default, so the delete helpers below do it in statements instead.
 */
export function ensureUnoDirectoryTables(sql: UnoDirectorySql) {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_users (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE,
			isAdmin INTEGER NOT NULL DEFAULT 0,
			joinedAt INTEGER NOT NULL,
			lastSeenAt INTEGER NOT NULL
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_workspaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			createdAt INTEGER NOT NULL
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_boards (
			id TEXT PRIMARY KEY,
			workspaceId TEXT NOT NULL,
			name TEXT NOT NULL,
			createdAt INTEGER NOT NULL
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_workspace_members (
			userId TEXT NOT NULL,
			workspaceId TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			PRIMARY KEY (userId, workspaceId)
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_board_members (
			userId TEXT NOT NULL,
			boardId TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			PRIMARY KEY (userId, boardId)
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_invites (
			token TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			scopeId TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			acceptedCount INTEGER NOT NULL DEFAULT 0
		)`
	)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS uno_sessions (
			token TEXT PRIMARY KEY,
			userId TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			lastSeenAt INTEGER NOT NULL
		)`
	)
}

interface UserRow {
	id: string
	name: string
	email: string
	isAdmin: number
	joinedAt: number
	lastSeenAt: number
}

function toUser(row: UserRow): UnoDirectoryUser {
	return { id: row.id, name: row.name, email: row.email, isAdmin: row.isAdmin === 1 }
}

function rows<T>(sql: UnoDirectorySql, query: string, ...bindings: unknown[]): T[] {
	return sql.exec(query, ...bindings).toArray() as T[]
}

/** Emails identify people across browsers, so they are matched case-insensitively and stored folded. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

export function normalizeName(name: string): string {
	return name.trim().slice(0, 64)
}

export function getUserByEmail(sql: UnoDirectorySql, email: string): UnoDirectoryUser | null {
	const found = rows<UserRow>(sql, 'SELECT * FROM uno_users WHERE email = ?', normalizeEmail(email))
	return found[0] ? toUser(found[0]) : null
}

export function getUserById(sql: UnoDirectorySql, id: string): UnoDirectoryUser | null {
	const found = rows<UserRow>(sql, 'SELECT * FROM uno_users WHERE id = ?', id)
	return found[0] ? toUser(found[0]) : null
}

/**
 * Creates the user for this email, or refreshes the name of the one that already exists.
 *
 * Following a second invite link is the common path here: the same person, already known by email,
 * arriving at a second workspace, which is what keeps the member list one row per human.
 *
 * Returns `'reserved'` for the admin's own address. Nothing verifies the email typed into the join
 * form, so without this anyone holding any invite link could type the admin's address and be handed
 * the admin's account — the secret check in `signInAdmin` would never be reached.
 */
export function upsertUser(
	sql: UnoDirectorySql,
	params: { id: string; name: string; email: string; now: number }
): UnoDirectoryUser | 'reserved' {
	const email = normalizeEmail(params.email)
	const name = normalizeName(params.name)
	const existing = rows<UserRow>(sql, 'SELECT * FROM uno_users WHERE email = ?', email)[0]
	if (email === normalizeEmail(UNO_ADMIN_EMAIL)) return 'reserved'
	if (existing) {
		if (existing.isAdmin === 1) return 'reserved'
		sql.exec(
			'UPDATE uno_users SET name = ?, lastSeenAt = ? WHERE id = ?',
			name,
			params.now,
			existing.id
		)
		return toUser({ ...existing, name })
	}
	sql.exec(
		'INSERT INTO uno_users (id, name, email, isAdmin, joinedAt, lastSeenAt) VALUES (?, ?, ?, 0, ?, ?)',
		params.id,
		name,
		email,
		params.now,
		params.now
	)
	return { id: params.id, name, email, isAdmin: false }
}

/**
 * The admin account, created on first successful secret check and returned unchanged after that.
 * The name and email are the fixed ones; only the shared secret decides whether this is reached.
 */
export function ensureAdminUser(
	sql: UnoDirectorySql,
	params: { id: string; name: string; email: string; now: number }
): UnoDirectoryUser {
	const email = normalizeEmail(params.email)
	const existing = rows<UserRow>(sql, 'SELECT * FROM uno_users WHERE email = ?', email)[0]
	if (existing) {
		sql.exec(
			'UPDATE uno_users SET isAdmin = 1, lastSeenAt = ? WHERE id = ?',
			params.now,
			existing.id
		)
		return { ...toUser(existing), isAdmin: true }
	}
	sql.exec(
		'INSERT INTO uno_users (id, name, email, isAdmin, joinedAt, lastSeenAt) VALUES (?, ?, ?, 1, ?, ?)',
		params.id,
		normalizeName(params.name),
		email,
		params.now,
		params.now
	)
	return { id: params.id, name: normalizeName(params.name), email, isAdmin: true }
}

/** The display name shown on this person's cursor and in the admin's member list. */
export function setUserName(sql: UnoDirectorySql, userId: string, name: string) {
	sql.exec('UPDATE uno_users SET name = ? WHERE id = ?', normalizeName(name), userId)
}

export function createSession(
	sql: UnoDirectorySql,
	params: { token: string; userId: string; now: number }
) {
	sql.exec(
		'INSERT OR REPLACE INTO uno_sessions (token, userId, createdAt, lastSeenAt) VALUES (?, ?, ?, ?)',
		params.token,
		params.userId,
		params.now,
		params.now
	)
}

/**
 * The user behind a session token, with the token's clock pushed forward.
 *
 * A session whose user has been deleted resolves to null and the row is dropped, so removing a
 * person is enough on its own — there is no separate session sweep to remember to run.
 */
export function touchSession(
	sql: UnoDirectorySql,
	token: string,
	now: number
): UnoDirectoryUser | null {
	if (!token) return null
	const found = rows<{ userId: string; lastSeenAt: number }>(
		sql,
		'SELECT userId, lastSeenAt FROM uno_sessions WHERE token = ?',
		token
	)[0]
	if (!found) return null
	if (now - found.lastSeenAt > SESSION_TTL_MS) {
		sql.exec('DELETE FROM uno_sessions WHERE token = ?', token)
		return null
	}
	const user = getUserById(sql, found.userId)
	if (!user) {
		sql.exec('DELETE FROM uno_sessions WHERE token = ?', token)
		return null
	}
	sql.exec('UPDATE uno_sessions SET lastSeenAt = ? WHERE token = ?', now, token)
	sql.exec('UPDATE uno_users SET lastSeenAt = ? WHERE id = ?', now, user.id)
	return user
}

export function deleteSession(sql: UnoDirectorySql, token: string) {
	sql.exec('DELETE FROM uno_sessions WHERE token = ?', token)
}

export function createWorkspace(
	sql: UnoDirectorySql,
	params: { id: string; name: string; now: number }
) {
	sql.exec(
		'INSERT INTO uno_workspaces (id, name, createdAt) VALUES (?, ?, ?)',
		params.id,
		params.name.trim().slice(0, 120),
		params.now
	)
}

export function createBoard(
	sql: UnoDirectorySql,
	params: { id: string; workspaceId: string; name: string; now: number }
): boolean {
	const workspace = rows(sql, 'SELECT id FROM uno_workspaces WHERE id = ?', params.workspaceId)[0]
	if (!workspace) return false
	sql.exec(
		'INSERT INTO uno_boards (id, workspaceId, name, createdAt) VALUES (?, ?, ?, ?)',
		params.id,
		params.workspaceId,
		params.name.trim().slice(0, 120),
		params.now
	)
	return true
}

export function renameWorkspace(sql: UnoDirectorySql, id: string, name: string) {
	sql.exec('UPDATE uno_workspaces SET name = ? WHERE id = ?', name.trim().slice(0, 120), id)
}

export function renameBoard(sql: UnoDirectorySql, id: string, name: string) {
	sql.exec('UPDATE uno_boards SET name = ? WHERE id = ?', name.trim().slice(0, 120), id)
}

/** The board ids a workspace owns, needed before deleting it so their live sessions can be ended. */
export function getBoardIdsForWorkspace(sql: UnoDirectorySql, workspaceId: string): string[] {
	return rows<{ id: string }>(
		sql,
		'SELECT id FROM uno_boards WHERE workspaceId = ?',
		workspaceId
	).map((r) => r.id)
}

export function deleteBoard(sql: UnoDirectorySql, boardId: string) {
	sql.exec('DELETE FROM uno_board_members WHERE boardId = ?', boardId)
	sql.exec("DELETE FROM uno_invites WHERE scope = 'board' AND scopeId = ?", boardId)
	sql.exec('DELETE FROM uno_boards WHERE id = ?', boardId)
}

export function deleteWorkspace(sql: UnoDirectorySql, workspaceId: string) {
	for (const boardId of getBoardIdsForWorkspace(sql, workspaceId)) deleteBoard(sql, boardId)
	sql.exec('DELETE FROM uno_workspace_members WHERE workspaceId = ?', workspaceId)
	sql.exec("DELETE FROM uno_invites WHERE scope = 'workspace' AND scopeId = ?", workspaceId)
	sql.exec('DELETE FROM uno_workspaces WHERE id = ?', workspaceId)
}

export function createInvite(
	sql: UnoDirectorySql,
	params: { token: string; scope: UnoInviteScope; scopeId: string; now: number }
): boolean {
	const exists =
		params.scope === 'workspace'
			? rows(sql, 'SELECT id FROM uno_workspaces WHERE id = ?', params.scopeId)[0]
			: rows(sql, 'SELECT id FROM uno_boards WHERE id = ?', params.scopeId)[0]
	if (!exists) return false
	sql.exec(
		'INSERT INTO uno_invites (token, scope, scopeId, createdAt, acceptedCount) VALUES (?, ?, ?, ?, 0)',
		params.token,
		params.scope,
		params.scopeId,
		params.now
	)
	return true
}

export function revokeInvite(sql: UnoDirectorySql, token: string) {
	sql.exec('DELETE FROM uno_invites WHERE token = ?', token)
}

interface InviteRow {
	token: string
	scope: UnoInviteScope
	scopeId: string
	createdAt: number
	acceptedCount: number
}

function getInviteRow(sql: UnoDirectorySql, token: string): InviteRow | null {
	return rows<InviteRow>(sql, 'SELECT * FROM uno_invites WHERE token = ?', token)[0] ?? null
}

/**
 * What a link leads to, or null when the token is unknown or its target has since been deleted.
 * Deliberately says nothing about who else is in there — an invite link is often forwarded, and
 * whoever holds it has not proved anything yet.
 */
export function getInviteInfo(sql: UnoDirectorySql, token: string): UnoInviteInfo | null {
	const invite = getInviteRow(sql, token)
	if (!invite) return null
	if (invite.scope === 'workspace') {
		const workspace = rows<{ name: string }>(
			sql,
			'SELECT name FROM uno_workspaces WHERE id = ?',
			invite.scopeId
		)[0]
		if (!workspace) return null
		return { scope: 'workspace', workspaceName: workspace.name, boardName: null }
	}
	const board = rows<{ name: string; workspaceName: string }>(
		sql,
		`SELECT b.name AS name, w.name AS workspaceName
		 FROM uno_boards b JOIN uno_workspaces w ON w.id = b.workspaceId
		 WHERE b.id = ?`,
		invite.scopeId
	)[0]
	if (!board) return null
	return { scope: 'board', workspaceName: board.workspaceName, boardName: board.name }
}

export function addMembership(
	sql: UnoDirectorySql,
	params: { userId: string; scope: UnoInviteScope; scopeId: string; now: number }
) {
	if (params.scope === 'workspace') {
		sql.exec(
			'INSERT OR IGNORE INTO uno_workspace_members (userId, workspaceId, createdAt) VALUES (?, ?, ?)',
			params.userId,
			params.scopeId,
			params.now
		)
	} else {
		sql.exec(
			'INSERT OR IGNORE INTO uno_board_members (userId, boardId, createdAt) VALUES (?, ?, ?)',
			params.userId,
			params.scopeId,
			params.now
		)
	}
}

/**
 * Redeems a link for a user, returning the invite so the caller knows what was granted.
 *
 * Links are reusable on purpose: one link per workspace is how the admin adds a group of people
 * without minting a token each. `acceptedCount` is what makes a link that has spread further than
 * intended visible in the admin list, since the link itself cannot be un-forwarded.
 */
export function acceptInvite(
	sql: UnoDirectorySql,
	params: { token: string; userId: string; now: number }
): InviteRow | null {
	const invite = getInviteRow(sql, params.token)
	if (!invite) return null
	if (!getInviteInfo(sql, params.token)) return null
	addMembership(sql, {
		userId: params.userId,
		scope: invite.scope,
		scopeId: invite.scopeId,
		now: params.now,
	})
	sql.exec('UPDATE uno_invites SET acceptedCount = acceptedCount + 1 WHERE token = ?', params.token)
	return invite
}

/**
 * Drops one membership and reports the boards the user has just lost, so their live sessions on
 * them can be closed. Removing a workspace membership can leave board memberships behind: those
 * were granted separately and are not this workspace's to revoke.
 */
export function removeMembership(
	sql: UnoDirectorySql,
	params: { userId: string; scope: UnoInviteScope; scopeId: string }
): string[] {
	const before = new Set(getAccessibleBoardIds(sql, params.userId))
	if (params.scope === 'workspace') {
		sql.exec(
			'DELETE FROM uno_workspace_members WHERE userId = ? AND workspaceId = ?',
			params.userId,
			params.scopeId
		)
	} else {
		sql.exec(
			'DELETE FROM uno_board_members WHERE userId = ? AND boardId = ?',
			params.userId,
			params.scopeId
		)
	}
	const after = new Set(getAccessibleBoardIds(sql, params.userId))
	return [...before].filter((id) => !after.has(id))
}

/** Removes a person from the service outright. Returns the boards they were on. */
export function removeUser(sql: UnoDirectorySql, userId: string): string[] {
	const lost = getAccessibleBoardIds(sql, userId)
	sql.exec('DELETE FROM uno_workspace_members WHERE userId = ?', userId)
	sql.exec('DELETE FROM uno_board_members WHERE userId = ?', userId)
	sql.exec('DELETE FROM uno_sessions WHERE userId = ?', userId)
	sql.exec('DELETE FROM uno_users WHERE id = ?', userId)
	return lost
}

/**
 * Every board this user may open: the ones they were invited to directly, plus every board in a
 * workspace they belong to — including boards added to it after they joined, which is the whole
 * difference between the two kinds of invite.
 */
export function getAccessibleBoardIds(sql: UnoDirectorySql, userId: string): string[] {
	const user = getUserById(sql, userId)
	if (!user) return []
	if (user.isAdmin) {
		return rows<{ id: string }>(sql, 'SELECT id FROM uno_boards').map((r) => r.id)
	}
	return rows<{ id: string }>(
		sql,
		`SELECT id FROM uno_boards
		 WHERE workspaceId IN (SELECT workspaceId FROM uno_workspace_members WHERE userId = ?)
		    OR id IN (SELECT boardId FROM uno_board_members WHERE userId = ?)`,
		userId,
		userId
	).map((r) => r.id)
}

export function canAccessBoard(sql: UnoDirectorySql, userId: string, boardId: string): boolean {
	const user = getUserById(sql, userId)
	if (!user) return false
	if (user.isAdmin) return rows(sql, 'SELECT id FROM uno_boards WHERE id = ?', boardId).length > 0
	return (
		rows(
			sql,
			`SELECT id FROM uno_boards
			 WHERE id = ?
			   AND (workspaceId IN (SELECT workspaceId FROM uno_workspace_members WHERE userId = ?)
			     OR id IN (SELECT boardId FROM uno_board_members WHERE userId = ?))`,
			boardId,
			userId,
			userId
		).length > 0
	)
}

/**
 * The workspaces and boards to show this user. The admin sees everything; everyone else sees the
 * workspaces they belong to in full, plus the individual boards they were invited to, listed under
 * their own workspace so the sidebar reads the same for both kinds of membership.
 */
export function getDirectoryForUser(sql: UnoDirectorySql, user: UnoDirectoryUser): UnoDirectory {
	const workspaceRows = user.isAdmin
		? rows<{ id: string; name: string }>(
				sql,
				'SELECT id, name FROM uno_workspaces ORDER BY createdAt'
			)
		: rows<{ id: string; name: string }>(
				sql,
				`SELECT id, name FROM uno_workspaces
				 WHERE id IN (SELECT workspaceId FROM uno_workspace_members WHERE userId = ?)
				 ORDER BY createdAt`,
				user.id
			)

	const boardRows = user.isAdmin
		? rows<{ id: string; name: string; workspaceId: string; workspaceName: string }>(
				sql,
				`SELECT b.id, b.name, b.workspaceId, w.name AS workspaceName
				 FROM uno_boards b JOIN uno_workspaces w ON w.id = b.workspaceId
				 ORDER BY w.createdAt, b.createdAt`
			)
		: rows<{ id: string; name: string; workspaceId: string; workspaceName: string }>(
				sql,
				`SELECT b.id, b.name, b.workspaceId, w.name AS workspaceName
				 FROM uno_boards b JOIN uno_workspaces w ON w.id = b.workspaceId
				 WHERE b.workspaceId IN (SELECT workspaceId FROM uno_workspace_members WHERE userId = ?)
				    OR b.id IN (SELECT boardId FROM uno_board_members WHERE userId = ?)
				 ORDER BY w.createdAt, b.createdAt`,
				user.id,
				user.id
			)

	const byId = new Map<string, UnoDirectoryWorkspace>()
	for (const w of workspaceRows) byId.set(w.id, { id: w.id, name: w.name, boards: [] })
	for (const b of boardRows) {
		let workspace = byId.get(b.workspaceId)
		if (!workspace) {
			// A board invite without its workspace: the workspace is listed only to give the board
			// somewhere to sit, and carries no other boards.
			workspace = { id: b.workspaceId, name: b.workspaceName, boards: [] }
			byId.set(b.workspaceId, workspace)
		}
		workspace.boards.push({ id: b.id, name: b.name, workspaceId: b.workspaceId })
	}

	return { user, workspaces: [...byId.values()] }
}

/** The admin's list of everyone who has accepted an invite, and where each of them can go. */
export function listMembers(sql: UnoDirectorySql): UnoMemberSummary[] {
	const users = rows<UserRow>(sql, 'SELECT * FROM uno_users ORDER BY joinedAt')
	const workspaceMemberships = rows<{ userId: string; id: string; name: string }>(
		sql,
		`SELECT m.userId, w.id, w.name FROM uno_workspace_members m
		 JOIN uno_workspaces w ON w.id = m.workspaceId
		 ORDER BY w.createdAt`
	)
	const boardMemberships = rows<{
		userId: string
		id: string
		name: string
		workspaceId: string
		workspaceName: string
	}>(
		sql,
		`SELECT m.userId, b.id, b.name, b.workspaceId, w.name AS workspaceName
		 FROM uno_board_members m
		 JOIN uno_boards b ON b.id = m.boardId
		 JOIN uno_workspaces w ON w.id = b.workspaceId
		 ORDER BY w.createdAt, b.createdAt`
	)

	return users.map((row) => ({
		user: toUser(row),
		workspaces: workspaceMemberships
			.filter((m) => m.userId === row.id)
			.map((m) => ({ id: m.id, name: m.name })),
		boards: boardMemberships
			.filter((m) => m.userId === row.id)
			.map((m) => ({
				id: m.id,
				name: m.name,
				workspaceId: m.workspaceId,
				workspaceName: m.workspaceName,
			})),
		joinedAt: row.joinedAt,
		lastSeenAt: row.lastSeenAt,
	}))
}

export function listInvites(sql: UnoDirectorySql): UnoInviteSummary[] {
	const invites = rows<InviteRow>(sql, 'SELECT * FROM uno_invites ORDER BY createdAt')
	return invites.flatMap((invite) => {
		const info = getInviteInfo(sql, invite.token)
		if (!info) return []
		return [
			{
				token: invite.token,
				scope: invite.scope,
				scopeId: invite.scopeId,
				label: info.boardName ? `${info.workspaceName} / ${info.boardName}` : info.workspaceName,
				createdAt: invite.createdAt,
				acceptedCount: invite.acceptedCount,
			},
		]
	})
}

/** The tables a dump carries, in the order the import has to insert them. */
export const UNO_DIRECTORY_TABLES = [
	'uno_users',
	'uno_workspaces',
	'uno_boards',
	'uno_workspace_members',
	'uno_board_members',
	'uno_invites',
	'uno_sessions',
] as const

export interface UnoDirectoryDump {
	version: 1
	exportedAt: number
	tables: Record<string, unknown[]>
}

/**
 * Every row in the directory, for moving it somewhere else.
 *
 * Durable Object storage cannot be copied off Cloudflare any other way — there is no export, and
 * the object is only reachable through code running inside it. Without this, migrating away means
 * everyone joining again from new invite links.
 */
export function exportUnoDirectory(sql: UnoDirectorySql, now: number): UnoDirectoryDump {
	const tables: Record<string, unknown[]> = {}
	for (const table of UNO_DIRECTORY_TABLES) {
		tables[table] = rows(sql, `SELECT * FROM ${table}`)
	}
	return { version: 1, exportedAt: now, tables }
}
