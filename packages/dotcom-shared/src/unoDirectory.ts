/**
 * Wire types for the invite-only directory.
 *
 * The app's boards are local documents (see localBoards.ts in the client), so the server holds no
 * board contents — only who exists, what they are allowed to open, and the invite links that got
 * them there. Everything here crosses between `apps/dotcom/client` and `apps/dotcom/sync-worker`.
 */

/**
 * The one account that can create workspaces and boards, invite people, and remove them. Fixed
 * rather than stored, so there is no "first user wins" bootstrap to race; proving you are this
 * user needs the shared secret the worker is deployed with (`UNO_ADMIN_SECRET`), not the address.
 */
export const UNO_ADMIN_NAME = 'Mikhail'
export const UNO_ADMIN_EMAIL = 'mpm@unocode.ru'

/**
 * What an invite grants. A `workspace` invite covers every board in that workspace, including ones
 * created later; a `board` invite covers exactly one board.
 */
export type UnoInviteScope = 'workspace' | 'board'

export interface UnoDirectoryUser {
	id: string
	name: string
	email: string
	isAdmin: boolean
}

export interface UnoDirectoryBoard {
	id: string
	name: string
	workspaceId: string
}

export interface UnoDirectoryWorkspace {
	id: string
	name: string
	boards: UnoDirectoryBoard[]
}

/** Everything one signed-in browser may see: itself, and the boards it is allowed to open. */
export interface UnoDirectory {
	user: UnoDirectoryUser
	workspaces: UnoDirectoryWorkspace[]
}

/** Shown on the join screen before a name and email are given, so the link says where it leads. */
export interface UnoInviteInfo {
	scope: UnoInviteScope
	workspaceName: string
	/** The board's name for a board invite; null for a workspace invite. */
	boardName: string | null
}

/** One row of the admin's member list. */
export interface UnoMemberSummary {
	user: UnoDirectoryUser
	/** Workspaces joined outright, which carry every board in them. */
	workspaces: { id: string; name: string }[]
	/** Boards joined one at a time, without their workspace. */
	boards: { id: string; name: string; workspaceId: string; workspaceName: string }[]
	joinedAt: number
	lastSeenAt: number
}

export interface UnoInviteSummary {
	token: string
	scope: UnoInviteScope
	scopeId: string
	/** "Workspace name" or "Workspace name / Board name", for display in the admin list. */
	label: string
	createdAt: number
	acceptedCount: number
}

/** Sent as the session credential on every directory request and on the presence socket. */
export const UNO_SESSION_QUERY_PARAM = 'uno_session'
