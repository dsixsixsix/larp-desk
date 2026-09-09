import {
	UNO_ADMIN_EMAIL,
	UNO_ADMIN_NAME,
	UnoDirectory,
	UnoDirectoryUser,
	UnoInviteInfo,
	UnoInviteScope,
	UnoInviteSummary,
	UnoMemberSummary,
} from '@tldraw/dotcom-shared'
import { DurableObject } from 'cloudflare:workers'
import { Environment } from './types'
import {
	acceptInvite,
	addMembership,
	canAccessBoard,
	createBoard,
	createInvite,
	createSession,
	createWorkspace,
	deleteBoard,
	deleteSession,
	deleteWorkspace,
	ensureAdminUser,
	ensureUnoDirectoryTables,
	getBoardIdsForWorkspace,
	getDirectoryForUser,
	getInviteInfo,
	getUserById,
	listInvites,
	listMembers,
	removeMembership,
	removeUser,
	renameBoard,
	renameWorkspace,
	revokeInvite,
	setUserName,
	touchSession,
	upsertUser,
} from './unoDirectoryStorage'

/**
 * Failed admin sign-ins allowed before the object stops checking, and for how long.
 *
 * The admin secret is the only thing standing between a visitor and the ability to create, delete
 * and un-invite everything, and it is checked by a Durable Object that serializes its requests —
 * so a lockout here really does bound the guess rate rather than one colo's share of it. Held in
 * memory rather than storage on purpose: an eviction resets the counter, but evicting the object
 * takes an idle period that a live guessing run does not have.
 */
const ADMIN_LOGIN_MAX_FAILURES = 5
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000

/** Invite tokens are looked up directly, so they carry all of their own unguessability. */
const INVITE_TOKEN_BYTES = 16

function randomToken(bytes = INVITE_TOKEN_BYTES): string {
	const buffer = new Uint8Array(bytes)
	crypto.getRandomValues(buffer)
	return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Compares two secrets without leaking their common prefix through timing.
 *
 * Length is compared first and returns early, which does leak the length — of a secret the
 * operator chose, not one that is being guessed character by character.
 */
function secretsMatch(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

export interface UnoSignInResult {
	sessionToken: string
	directory: UnoDirectory
}

/**
 * The whole of the service's account system: who has been invited, what they may open, and the
 * links that let them in.
 *
 * There is exactly one of these — the worker addresses it by a fixed name — because every question
 * it answers ("is this person allowed on this board", "who is in this workspace") spans all of the
 * data at once, and sharding it by anything would turn each of those into a fan-out.
 *
 * Board *contents* never reach it: those stay in each browser's IndexedDB (see localBoards.ts in
 * the client). What is stored here is only the directory around them.
 */
export class UnoDirectoryDurableObject extends DurableObject<Environment> {
	private readonly sql = this.ctx.storage.sql
	private adminLoginFailures = 0
	private adminLockedUntil = 0

	constructor(ctx: DurableObjectState, env: Environment) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(async () => {
			ensureUnoDirectoryTables(this.sql)
		})
	}

	/**
	 * Exchanges the deployment's admin secret for a session. The name and email are the fixed ones
	 * in `@tldraw/dotcom-shared`; possession of the secret is the entire check.
	 */
	async signInAdmin(secret: string): Promise<UnoSignInResult | 'locked' | 'denied'> {
		const now = Date.now()
		if (now < this.adminLockedUntil) return 'locked'

		const expected = this.env.UNO_ADMIN_SECRET
		// An unset secret must never mean "everyone is admin". A deployment without one has no way
		// in at all, which is the failure the operator can see and fix.
		if (!expected || !secret || !secretsMatch(secret, expected)) {
			this.adminLoginFailures++
			if (this.adminLoginFailures >= ADMIN_LOGIN_MAX_FAILURES) {
				this.adminLockedUntil = now + ADMIN_LOGIN_LOCKOUT_MS
				this.adminLoginFailures = 0
			}
			return 'denied'
		}

		this.adminLoginFailures = 0
		const user = ensureAdminUser(this.sql, {
			id: `uno-user-${randomToken(8)}`,
			name: UNO_ADMIN_NAME,
			email: UNO_ADMIN_EMAIL,
			now,
		})
		return this.startSession(user, now)
	}

	/** The invite's target, for the join screen. Null for an unknown or dangling token. */
	async getInvite(token: string): Promise<UnoInviteInfo | null> {
		return getInviteInfo(this.sql, token)
	}

	/**
	 * Redeems an invite link under a name and email, and hands back a session.
	 *
	 * The email is the identity: following a second link with the same address adds to the same
	 * person rather than creating another, which is what keeps the admin's member list one row per
	 * human. It is not verified — nothing is sent to it — so it identifies, it does not authenticate;
	 * holding the link is the credential. That is exactly why the admin's own address is refused
	 * here rather than treated as a login (see `upsertUser`).
	 */
	async acceptInvite(
		token: string,
		name: string,
		email: string
	): Promise<UnoSignInResult | 'invalid' | 'reserved'> {
		const now = Date.now()
		if (!getInviteInfo(this.sql, token)) return 'invalid'
		const user = upsertUser(this.sql, { id: `uno-user-${randomToken(8)}`, name, email, now })
		// The admin's address is not joinable: it signs in with the deployment secret instead, and
		// an invite form that accepted it would be a way around that check.
		if (user === 'reserved') return 'reserved'
		const invite = acceptInvite(this.sql, { token, userId: user.id, now })
		if (!invite) return 'invalid'
		return this.startSession(user, now)
	}

	/** The current directory for a session token, or null once it is gone or its user is removed. */
	async getDirectory(sessionToken: string): Promise<UnoDirectory | null> {
		const user = touchSession(this.sql, sessionToken, Date.now())
		if (!user) return null
		return getDirectoryForUser(this.sql, user)
	}

	/**
	 * Changes the caller's own display name. The email is not editable: it is the identity two
	 * invites are matched on, so changing it would fork one person into two.
	 */
	async updateOwnName(sessionToken: string, name: string): Promise<UnoDirectory | null> {
		const user = touchSession(this.sql, sessionToken, Date.now())
		if (!user) return null
		setUserName(this.sql, user.id, name)
		const updated = getUserById(this.sql, user.id)
		if (!updated) return null
		return getDirectoryForUser(this.sql, updated)
	}

	async signOut(sessionToken: string): Promise<void> {
		deleteSession(this.sql, sessionToken)
	}

	/**
	 * The user id behind a session that may open this board, or null. Called on every presence
	 * socket, which is what makes removing someone take effect rather than only hiding the board.
	 */
	async authorizeBoard(sessionToken: string, boardId: string): Promise<string | null> {
		const user = touchSession(this.sql, sessionToken, Date.now())
		if (!user) return null
		return canAccessBoard(this.sql, user.id, boardId) ? user.id : null
	}

	async createWorkspace(sessionToken: string, name: string): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		const now = Date.now()
		const workspaceId = `uno-ws-${randomToken(8)}`
		createWorkspace(this.sql, { id: workspaceId, name, now })
		addMembership(this.sql, { userId: admin.id, scope: 'workspace', scopeId: workspaceId, now })
		return getDirectoryForUser(this.sql, admin)
	}

	/**
	 * The board id doubles as the tldraw persistence key in every browser that opens it, so it is
	 * minted here rather than client-side: two people creating boards must never collide on one
	 * IndexedDB database, and only the server sees all of the creations.
	 */
	async createBoard(
		sessionToken: string,
		workspaceId: string,
		name: string
	): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		const now = Date.now()
		if (!createBoard(this.sql, { id: `uno-board-${randomToken(8)}`, workspaceId, name, now })) {
			return null
		}
		return getDirectoryForUser(this.sql, admin)
	}

	async renameWorkspace(
		sessionToken: string,
		workspaceId: string,
		name: string
	): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		renameWorkspace(this.sql, workspaceId, name)
		return getDirectoryForUser(this.sql, admin)
	}

	async renameBoard(
		sessionToken: string,
		boardId: string,
		name: string
	): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		renameBoard(this.sql, boardId, name)
		return getDirectoryForUser(this.sql, admin)
	}

	async deleteBoard(sessionToken: string, boardId: string): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		deleteBoard(this.sql, boardId)
		await this.endSessionsOn([boardId])
		return getDirectoryForUser(this.sql, admin)
	}

	async deleteWorkspace(sessionToken: string, workspaceId: string): Promise<UnoDirectory | null> {
		const admin = this.requireAdmin(sessionToken)
		if (!admin) return null
		const boardIds = getBoardIdsForWorkspace(this.sql, workspaceId)
		deleteWorkspace(this.sql, workspaceId)
		await this.endSessionsOn(boardIds)
		return getDirectoryForUser(this.sql, admin)
	}

	async createInvite(
		sessionToken: string,
		scope: UnoInviteScope,
		scopeId: string
	): Promise<string | null> {
		if (!this.requireAdmin(sessionToken)) return null
		const token = randomToken()
		if (!createInvite(this.sql, { token, scope, scopeId, now: Date.now() })) return null
		return token
	}

	async revokeInvite(sessionToken: string, token: string): Promise<boolean> {
		if (!this.requireAdmin(sessionToken)) return false
		revokeInvite(this.sql, token)
		return true
	}

	async listInvites(sessionToken: string): Promise<UnoInviteSummary[] | null> {
		if (!this.requireAdmin(sessionToken)) return null
		return listInvites(this.sql)
	}

	async listMembers(sessionToken: string): Promise<UnoMemberSummary[] | null> {
		if (!this.requireAdmin(sessionToken)) return null
		return listMembers(this.sql)
	}

	/**
	 * Takes one membership away. Whoever loses access is dropped from those boards' live sessions
	 * on the way out, so "remove from board" ends the call they are on rather than waiting for
	 * their next reload.
	 */
	async removeMember(
		sessionToken: string,
		userId: string,
		scope: UnoInviteScope,
		scopeId: string
	): Promise<UnoMemberSummary[] | null> {
		if (!this.requireAdmin(sessionToken)) return null
		const target = getUserById(this.sql, userId)
		// The admin's own memberships are what make every board reachable from their sidebar; there
		// is also no one left to grant them back.
		if (!target || target.isAdmin) return null
		const lostBoardIds = removeMembership(this.sql, { userId, scope, scopeId })
		await this.evictFrom(lostBoardIds, userId)
		return listMembers(this.sql)
	}

	async removeUser(sessionToken: string, userId: string): Promise<UnoMemberSummary[] | null> {
		if (!this.requireAdmin(sessionToken)) return null
		const target = getUserById(this.sql, userId)
		if (!target || target.isAdmin) return null
		const lostBoardIds = removeUser(this.sql, userId)
		await this.evictFrom(lostBoardIds, userId)
		return listMembers(this.sql)
	}

	private startSession(user: UnoDirectoryUser, now: number): UnoSignInResult {
		const sessionToken = randomToken(24)
		createSession(this.sql, { token: sessionToken, userId: user.id, now })
		return { sessionToken, directory: getDirectoryForUser(this.sql, user) }
	}

	private requireAdmin(sessionToken: string): UnoDirectoryUser | null {
		const user = touchSession(this.sql, sessionToken, Date.now())
		return user?.isAdmin ? user : null
	}

	private async evictFrom(boardIds: string[], userId: string) {
		await Promise.all(
			boardIds.map((boardId) =>
				this.env.UNO_BOARD_PRESENCE.get(this.env.UNO_BOARD_PRESENCE.idFromName(boardId)).evictUser(
					userId
				)
			)
		)
	}

	private async endSessionsOn(boardIds: string[]) {
		await Promise.all(
			boardIds.map((boardId) =>
				this.env.UNO_BOARD_PRESENCE.get(this.env.UNO_BOARD_PRESENCE.idFromName(boardId)).evictAll()
			)
		)
	}
}
