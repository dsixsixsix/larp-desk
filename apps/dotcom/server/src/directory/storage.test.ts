import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
	UnoDirectorySql,
	acceptInvite,
	canAccessBoard,
	createBoard,
	createInvite,
	createSession,
	createWorkspace,
	deleteWorkspace,
	ensureAdminUser,
	ensureUnoDirectoryTables,
	getDirectoryForUser,
	getInviteInfo,
	listMembers,
	removeMembership,
	removeUser,
	touchSession,
	upsertUser,
} from './storage'

// Run against a real SQLite database rather than a fake: the unique constraint on email and the
// membership primary keys are the design here, and a stub that accepts anything proves nothing.
function makeSql(): UnoDirectorySql {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...bindings: unknown[]) {
			const statement = db.prepare(query)
			if (/^\s*select/i.test(query.trim())) {
				return { toArray: () => statement.all(...(bindings as any[])) }
			}
			statement.run(...(bindings as any[]))
			return { toArray: () => [] }
		},
	}
}

const NOW = 1_700_000_000_000

/** `upsertUser` for an ordinary address, which is every address in these tests but the admin's. */
function joiner(sql: UnoDirectorySql, params: { id: string; name: string; email: string }) {
	const user = upsertUser(sql, { ...params, now: NOW })
	if (user === 'reserved') throw new Error('expected an ordinary user')
	return user
}

/** A directory with one workspace holding two boards, and nobody in it but the admin. */
function seed() {
	const sql = makeSql()
	ensureUnoDirectoryTables(sql)
	const admin = ensureAdminUser(sql, {
		id: 'admin',
		name: 'Mikhail',
		email: 'MPM@unocode.ru',
		now: NOW,
	})
	createWorkspace(sql, { id: 'ws1', name: 'Design', now: NOW })
	createBoard(sql, { id: 'b1', workspaceId: 'ws1', name: 'Board 1', now: NOW })
	createBoard(sql, { id: 'b2', workspaceId: 'ws1', name: 'Board 2', now: NOW })
	return { sql, admin }
}

describe('invites', () => {
	it('grants every board in a workspace, including ones added later', () => {
		const { sql } = seed()
		createInvite(sql, { token: 't1', scope: 'workspace', scopeId: 'ws1', now: NOW })
		const user = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		acceptInvite(sql, { token: 't1', userId: user.id, now: NOW })

		createBoard(sql, { id: 'b3', workspaceId: 'ws1', name: 'Board 3', now: NOW })

		expect(getDirectoryForUser(sql, user)).toEqual({
			user,
			workspaces: [
				{
					id: 'ws1',
					name: 'Design',
					boards: [
						{ id: 'b1', name: 'Board 1', workspaceId: 'ws1' },
						{ id: 'b2', name: 'Board 2', workspaceId: 'ws1' },
						{ id: 'b3', name: 'Board 3', workspaceId: 'ws1' },
					],
				},
			],
		})
	})

	it('grants one board without the rest of its workspace', () => {
		const { sql } = seed()
		createInvite(sql, { token: 't2', scope: 'board', scopeId: 'b2', now: NOW })
		const user = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		acceptInvite(sql, { token: 't2', userId: user.id, now: NOW })

		expect(getDirectoryForUser(sql, user)).toEqual({
			user,
			workspaces: [
				{ id: 'ws1', name: 'Design', boards: [{ id: 'b2', name: 'Board 2', workspaceId: 'ws1' }] },
			],
		})
		expect(canAccessBoard(sql, user.id, 'b2')).toBe(true)
		expect(canAccessBoard(sql, user.id, 'b1')).toBe(false)
	})

	it('joins the same person to a second workspace when they reuse their email', () => {
		const { sql } = seed()
		createWorkspace(sql, { id: 'ws2', name: 'Research', now: NOW })
		createBoard(sql, { id: 'b9', workspaceId: 'ws2', name: 'Notes', now: NOW })
		createInvite(sql, { token: 't1', scope: 'workspace', scopeId: 'ws1', now: NOW })
		createInvite(sql, { token: 't2', scope: 'workspace', scopeId: 'ws2', now: NOW })

		const first = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		acceptInvite(sql, { token: 't1', userId: first.id, now: NOW })
		// Same address, different capitalisation and a corrected name — one person, not two.
		const second = joiner(sql, { id: 'u2', name: 'Ann B', email: 'Ann@Example.com' })
		acceptInvite(sql, { token: 't2', userId: second.id, now: NOW })

		expect(second.id).toBe(first.id)
		expect(getDirectoryForUser(sql, second).workspaces.map((w) => w.id)).toEqual(['ws1', 'ws2'])
		expect(listMembers(sql)).toHaveLength(2)
	})

	it('refuses the admin address, which would otherwise hand out the admin account', () => {
		const { sql } = seed()
		createInvite(sql, { token: 't1', scope: 'workspace', scopeId: 'ws1', now: NOW })
		// Nothing verifies the address typed into the join form, so this must not resolve to the
		// admin's row no matter how it is spelled.
		expect(
			upsertUser(sql, { id: 'u1', name: 'Not Mikhail', email: ' MPM@UNOCODE.RU ', now: NOW })
		).toBe('reserved')
	})

	it('reports a token whose target has been deleted as unusable', () => {
		const { sql } = seed()
		createInvite(sql, { token: 't1', scope: 'workspace', scopeId: 'ws1', now: NOW })
		deleteWorkspace(sql, 'ws1')
		expect(getInviteInfo(sql, 't1')).toBeNull()
		const user = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		expect(acceptInvite(sql, { token: 't1', userId: user.id, now: NOW })).toBeNull()
	})
})

describe('removing people', () => {
	it('reports the boards a revoked workspace membership cost, and keeps board invites', () => {
		const { sql } = seed()
		createInvite(sql, { token: 'tw', scope: 'workspace', scopeId: 'ws1', now: NOW })
		createInvite(sql, { token: 'tb', scope: 'board', scopeId: 'b2', now: NOW })
		const user = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		acceptInvite(sql, { token: 'tw', userId: user.id, now: NOW })
		acceptInvite(sql, { token: 'tb', userId: user.id, now: NOW })

		// b2 was granted twice over; only b1 is actually lost.
		expect(removeMembership(sql, { userId: user.id, scope: 'workspace', scopeId: 'ws1' })).toEqual([
			'b1',
		])
		expect(canAccessBoard(sql, user.id, 'b2')).toBe(true)
	})

	it('ends the sessions of a user who is removed outright', () => {
		const { sql } = seed()
		createInvite(sql, { token: 'tw', scope: 'workspace', scopeId: 'ws1', now: NOW })
		const user = joiner(sql, { id: 'u1', name: 'Ann', email: 'ann@example.com' })
		acceptInvite(sql, { token: 'tw', userId: user.id, now: NOW })
		createSession(sql, { token: 's1', userId: user.id, now: NOW })

		expect(removeUser(sql, user.id).sort()).toEqual(['b1', 'b2'])
		expect(touchSession(sql, 's1', NOW)).toBeNull()
	})
})

describe('the admin', () => {
	it('sees every workspace and board without being invited to them', () => {
		const { sql, admin } = seed()
		createWorkspace(sql, { id: 'ws2', name: 'Research', now: NOW })
		createBoard(sql, { id: 'b9', workspaceId: 'ws2', name: 'Notes', now: NOW })

		expect(
			getDirectoryForUser(sql, admin).workspaces.map((w) => w.boards.map((b) => b.id))
		).toEqual([['b1', 'b2'], ['b9']])
		expect(canAccessBoard(sql, admin.id, 'b9')).toBe(true)
	})

	it('is still refused a board id that does not exist', () => {
		const { sql, admin } = seed()
		expect(canAccessBoard(sql, admin.id, 'nope')).toBe(false)
	})
})

describe('sessions', () => {
	it('expires one that has gone unused for longer than the ttl', () => {
		const { sql } = seed()
		createSession(sql, { token: 's1', userId: 'admin', now: NOW })
		expect(touchSession(sql, 's1', NOW + 1000)?.id).toBe('admin')
		expect(touchSession(sql, 's1', NOW + 200 * 24 * 60 * 60 * 1000)).toBeNull()
	})
})
