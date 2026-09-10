import { UNO_SESSION_QUERY_PARAM, UnoInviteScope } from '@tldraw/dotcom-shared'
import { createRouter } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { Environment } from '../../types'
import { getUnoDirectory } from '../../utils/durableObjects'

/**
 * HTTP in front of `UnoDirectoryDurableObject`. Every route is a thin translation: the object owns
 * the rules, and these decide only what a failure looks like on the wire.
 *
 * The session token arrives as a bearer token on ordinary requests. The presence socket cannot set
 * a header, so it carries the token in a query parameter instead (see the presence route in
 * worker.ts); that is the only place it appears in a URL.
 */
export const unoDirectoryRoutes = createRouter<Environment>()

function sessionToken(request: IRequest): string {
	const header = request.headers.get('authorization') ?? ''
	const match = /^Bearer\s+(.+)$/i.exec(header)
	if (match) return match[1].trim()
	return new URL(request.url).searchParams.get(UNO_SESSION_QUERY_PARAM) ?? ''
}

async function readJson(request: IRequest): Promise<Record<string, unknown>> {
	try {
		const body = await request.json()
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

function scopeOf(value: unknown): UnoInviteScope | null {
	return value === 'workspace' || value === 'board' ? value : null
}

/** Every admin route answers the same way when the session isn't the admin's: it isn't there. */
const FORBIDDEN = () => Response.json({ error: 'forbidden' }, { status: 403 })

unoDirectoryRoutes
	.post('/uno/admin/login', async (request, env) => {
		const body = await readJson(request)
		const result = await getUnoDirectory(env).signInAdmin(str(body.secret))
		if (result === 'locked') {
			return Response.json({ error: 'locked' }, { status: 429 })
		}
		if (result === 'denied') {
			return Response.json({ error: 'denied' }, { status: 401 })
		}
		return Response.json(result)
	})
	.get('/uno/invite/:token', async (request, env) => {
		const invite = await getUnoDirectory(env).getInvite(request.params.token)
		if (!invite) return Response.json({ error: 'not-found' }, { status: 404 })
		return Response.json(invite)
	})
	.post('/uno/invite/:token/accept', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		const email = str(body.email).trim()
		if (!name || !email) return Response.json({ error: 'invalid' }, { status: 400 })
		const result = await getUnoDirectory(env).acceptInvite(request.params.token, name, email)
		if (result === 'invalid') return Response.json({ error: 'not-found' }, { status: 404 })
		if (result === 'reserved') return Response.json({ error: 'reserved' }, { status: 409 })
		return Response.json(result)
	})
	.get('/uno/directory', async (request, env) => {
		const directory = await getUnoDirectory(env).getDirectory(sessionToken(request))
		// 401 rather than an empty directory: "signed in with nothing to open" and "not signed in"
		// lead to different screens, and only the client can tell them apart from the status.
		if (!directory) return Response.json({ error: 'unauthenticated' }, { status: 401 })
		return Response.json(directory)
	})
	.post('/uno/profile', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		if (!name) return Response.json({ error: 'invalid' }, { status: 400 })
		const directory = await getUnoDirectory(env).updateOwnName(sessionToken(request), name)
		if (!directory) return Response.json({ error: 'unauthenticated' }, { status: 401 })
		return Response.json(directory)
	})
	.post('/uno/signout', async (request, env) => {
		await getUnoDirectory(env).signOut(sessionToken(request))
		return Response.json({ ok: true })
	})
	.post('/uno/admin/workspaces', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		if (!name) return Response.json({ error: 'invalid' }, { status: 400 })
		const directory = await getUnoDirectory(env).createWorkspace(sessionToken(request), name)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.post('/uno/admin/boards', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		const workspaceId = str(body.workspaceId)
		if (!name || !workspaceId) return Response.json({ error: 'invalid' }, { status: 400 })
		const directory = await getUnoDirectory(env).createBoard(
			sessionToken(request),
			workspaceId,
			name
		)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.post('/uno/admin/workspaces/:id/rename', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		if (!name) return Response.json({ error: 'invalid' }, { status: 400 })
		const directory = await getUnoDirectory(env).renameWorkspace(
			sessionToken(request),
			request.params.id,
			name
		)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.post('/uno/admin/boards/:id/rename', async (request, env) => {
		const body = await readJson(request)
		const name = str(body.name).trim()
		if (!name) return Response.json({ error: 'invalid' }, { status: 400 })
		const directory = await getUnoDirectory(env).renameBoard(
			sessionToken(request),
			request.params.id,
			name
		)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.delete('/uno/admin/workspaces/:id', async (request, env) => {
		const directory = await getUnoDirectory(env).deleteWorkspace(
			sessionToken(request),
			request.params.id
		)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.delete('/uno/admin/boards/:id', async (request, env) => {
		const directory = await getUnoDirectory(env).deleteBoard(
			sessionToken(request),
			request.params.id
		)
		return directory ? Response.json(directory) : FORBIDDEN()
	})
	.get('/uno/admin/invites', async (request, env) => {
		const invites = await getUnoDirectory(env).listInvites(sessionToken(request))
		return invites ? Response.json(invites) : FORBIDDEN()
	})
	.post('/uno/admin/invites', async (request, env) => {
		const body = await readJson(request)
		const scope = scopeOf(body.scope)
		const scopeId = str(body.scopeId)
		if (!scope || !scopeId) return Response.json({ error: 'invalid' }, { status: 400 })
		const token = await getUnoDirectory(env).createInvite(sessionToken(request), scope, scopeId)
		return token ? Response.json({ token }) : FORBIDDEN()
	})
	.delete('/uno/admin/invites/:token', async (request, env) => {
		const ok = await getUnoDirectory(env).revokeInvite(sessionToken(request), request.params.token)
		return ok ? Response.json({ ok: true }) : FORBIDDEN()
	})
	.get('/uno/admin/members', async (request, env) => {
		const members = await getUnoDirectory(env).listMembers(sessionToken(request))
		return members ? Response.json(members) : FORBIDDEN()
	})
	.post('/uno/admin/members/remove', async (request, env) => {
		const body = await readJson(request)
		const scope = scopeOf(body.scope)
		const userId = str(body.userId)
		const scopeId = str(body.scopeId)
		if (!scope || !userId || !scopeId) return Response.json({ error: 'invalid' }, { status: 400 })
		const members = await getUnoDirectory(env).removeMember(
			sessionToken(request),
			userId,
			scope,
			scopeId
		)
		return members ? Response.json(members) : FORBIDDEN()
	})
	.get('/uno/admin/export', async (request, env) => {
		const dump = await getUnoDirectory(env).exportDirectory(sessionToken(request))
		return dump ? Response.json(dump) : FORBIDDEN()
	})
	.post('/uno/admin/users/remove', async (request, env) => {
		const body = await readJson(request)
		const userId = str(body.userId)
		if (!userId) return Response.json({ error: 'invalid' }, { status: 400 })
		const members = await getUnoDirectory(env).removeUser(sessionToken(request), userId)
		return members ? Response.json(members) : FORBIDDEN()
	})

/** The session token on a request, for callers outside this router (the presence route). */
export function getUnoSessionToken(request: IRequest): string {
	return sessionToken(request)
}
