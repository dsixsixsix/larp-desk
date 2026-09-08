import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'tldraw-dotcom:local-boards-v1'
const DB_PREFIX = 'TLDRAW_DOCUMENT_v2'

const deleteDatabase = vi.fn()

/** Fresh module per test: the boards state is a module-level atom seeded from local storage. */
async function loadModule() {
	vi.resetModules()
	return await import('./localBoards')
}

beforeEach(() => {
	deleteDatabase.mockClear()
	window.localStorage.clear()
	;(globalThis as any).indexedDB = { deleteDatabase }
})

afterEach(() => {
	delete (globalThis as any).indexedDB
})

describe('localBoards', () => {
	it('bootstraps one workspace holding one board', async () => {
		const boards = await loadModule()
		const state = boards.getLocalBoardsState().get()
		expect(state.workspaces).toHaveLength(1)
		expect(state.boards).toHaveLength(1)
		expect(state.currentBoardId).toBe(state.boards[0].id)
		expect(state.boards[0].workspaceId).toBe(state.workspaces[0].id)
	})

	it('gives each board its own id, so no two share a document', async () => {
		const boards = await loadModule()
		const workspaceId = boards.getCurrentWorkspace().id
		const first = boards.createBoard('First', workspaceId)
		const second = boards.createBoard('Second', workspaceId)
		expect(first).not.toBe(second)
		expect(
			new Set(
				boards
					.getLocalBoardsState()
					.get()
					.boards.map((b) => b.id)
			).size
		).toBe(3)
	})

	it('switches to the new board on create', async () => {
		const boards = await loadModule()
		const id = boards.createBoard('New', boards.getCurrentWorkspace().id)
		expect(boards.getCurrentBoard().id).toBe(id)
	})

	it('creating a workspace also creates a board in it and moves there', async () => {
		const boards = await loadModule()
		const boardId = boards.createWorkspace('Second workspace')
		const state = boards.getLocalBoardsState().get()
		expect(state.workspaces).toHaveLength(2)
		expect(state.currentBoardId).toBe(boardId)
		expect(boards.getCurrentWorkspace().name).toBe('Second workspace')
	})

	it('only lists the boards of the workspace asked for', async () => {
		const boards = await loadModule()
		const first = boards.getCurrentWorkspace().id
		boards.createBoard('A', first)
		boards.createWorkspace('Other')
		const second = boards.getCurrentWorkspace().id

		expect(boards.getBoardsForWorkspace(first)).toHaveLength(2)
		expect(boards.getBoardsForWorkspace(second)).toHaveLength(1)
	})

	it('renames boards and workspaces', async () => {
		const boards = await loadModule()
		const boardId = boards.getCurrentBoard().id
		const workspaceId = boards.getCurrentWorkspace().id

		boards.renameBoard(boardId, '  Renamed board  ')
		boards.renameWorkspace(workspaceId, 'Renamed workspace')

		expect(boards.getCurrentBoard().name).toBe('Renamed board')
		expect(boards.getCurrentWorkspace().name).toBe('Renamed workspace')
	})

	it('ignores an empty rename rather than leaving a nameless row', async () => {
		const boards = await loadModule()
		const boardId = boards.getCurrentBoard().id
		const before = boards.getCurrentBoard().name
		boards.renameBoard(boardId, '   ')
		expect(boards.getCurrentBoard().name).toBe(before)
	})

	it('deletes a board and its document database', async () => {
		const boards = await loadModule()
		const workspaceId = boards.getCurrentWorkspace().id
		const doomed = boards.createBoard('Doomed', workspaceId)

		boards.deleteBoard(doomed)

		expect(
			boards
				.getLocalBoardsState()
				.get()
				.boards.map((b) => b.id)
		).not.toContain(doomed)
		expect(deleteDatabase).toHaveBeenCalledWith(DB_PREFIX + doomed)
	})

	it('moves to a sibling in the same workspace when the open board is deleted', async () => {
		const boards = await loadModule()
		const workspaceId = boards.getCurrentWorkspace().id
		const sibling = boards.getCurrentBoard().id
		const doomed = boards.createBoard('Doomed', workspaceId)
		expect(boards.getCurrentBoard().id).toBe(doomed)

		boards.deleteBoard(doomed)

		expect(boards.getCurrentBoard().id).toBe(sibling)
	})

	it('deletes the workspace along with its last board', async () => {
		const boards = await loadModule()
		const onlyBoardOfSecond = boards.createWorkspace('Second')
		const secondId = boards.getCurrentWorkspace().id

		boards.deleteBoard(onlyBoardOfSecond)

		const state = boards.getLocalBoardsState().get()
		expect(state.workspaces.map((w) => w.id)).not.toContain(secondId)
	})

	it('refuses to delete the last board, since the app has no empty state', async () => {
		const boards = await loadModule()
		const only = boards.getCurrentBoard().id
		expect(boards.canDeleteBoard(only)).toBe(false)

		boards.deleteBoard(only)

		expect(boards.getLocalBoardsState().get().boards).toHaveLength(1)
		expect(deleteDatabase).not.toHaveBeenCalled()
	})

	it('deletes a workspace with every board in it', async () => {
		const boards = await loadModule()
		const keptBoard = boards.getCurrentBoard().id
		boards.createWorkspace('Second')
		const secondId = boards.getCurrentWorkspace().id
		const extra = boards.createBoard('Extra', secondId)
		const secondBoards = boards.getBoardsForWorkspace(secondId).map((b) => b.id)

		expect(boards.canDeleteWorkspace(secondId)).toBe(true)
		boards.deleteWorkspace(secondId)

		const state = boards.getLocalBoardsState().get()
		expect(state.workspaces.map((w) => w.id)).not.toContain(secondId)
		expect(state.boards.map((b) => b.id)).toEqual([keptBoard])
		expect(state.currentBoardId).toBe(keptBoard)
		for (const id of secondBoards) expect(deleteDatabase).toHaveBeenCalledWith(DB_PREFIX + id)
		expect(deleteDatabase).toHaveBeenCalledWith(DB_PREFIX + extra)
	})

	it('refuses to delete the last workspace', async () => {
		const boards = await loadModule()
		const only = boards.getCurrentWorkspace().id
		expect(boards.canDeleteWorkspace(only)).toBe(false)
		boards.deleteWorkspace(only)
		expect(boards.getLocalBoardsState().get().workspaces).toHaveLength(1)
	})

	it('prunes deleted databases from the editor’s own database index', async () => {
		const boards = await loadModule()
		const doomed = boards.createBoard('Doomed', boards.getCurrentWorkspace().id)
		window.localStorage.setItem(
			'TLDRAW_DB_NAME_INDEX_v2',
			JSON.stringify([DB_PREFIX + doomed, 'TLDRAW_DOCUMENT_v2keep-me'])
		)

		boards.deleteBoard(doomed)

		expect(JSON.parse(window.localStorage.getItem('TLDRAW_DB_NAME_INDEX_v2')!)).toEqual([
			'TLDRAW_DOCUMENT_v2keep-me',
		])
	})

	it('clears every board and its content on a full reset', async () => {
		const boards = await loadModule()
		const workspaceId = boards.getCurrentWorkspace().id
		boards.createBoard('A', workspaceId)
		const all = boards
			.getLocalBoardsState()
			.get()
			.boards.map((b) => b.id)

		boards.deleteAllLocalBoards()

		for (const id of all) expect(deleteDatabase).toHaveBeenCalledWith(DB_PREFIX + id)
		expect(window.localStorage.getItem(STORAGE_KEY)).toBeFalsy()
	})

	it('adds a board from a link and opens it', async () => {
		const boards = await loadModule()
		const workspaceId = boards.getCurrentWorkspace().id

		boards.adoptBoard('tla-board-from-a-friend', 'Their board')

		const state = boards.getLocalBoardsState().get()
		expect(state.currentBoardId).toBe('tla-board-from-a-friend')
		expect(boards.getCurrentBoard().name).toBe('Their board')
		// Joined boards go in the workspace the user is already in, so no orphan is left behind.
		expect(boards.getCurrentBoard().workspaceId).toBe(workspaceId)
	})

	it('names an unnamed joined board rather than leaving a blank row', async () => {
		const boards = await loadModule()
		boards.adoptBoard('tla-board-unnamed')
		expect(boards.getCurrentBoard().name).toBe('Shared board')
	})

	it('opens a board it already knows instead of adding a duplicate', async () => {
		const boards = await loadModule()
		const existing = boards.getCurrentBoard().id
		boards.createBoard('Other', boards.getCurrentWorkspace().id)
		expect(boards.getCurrentBoard().id).not.toBe(existing)

		boards.adoptBoard(existing, 'A different name')

		const state = boards.getLocalBoardsState().get()
		expect(state.currentBoardId).toBe(existing)
		expect(state.boards.filter((b) => b.id === existing)).toHaveLength(1)
		// The name it already had wins: this browser's own board isn't renamed by someone's link.
		expect(boards.getCurrentBoard().name).toBe('Board 1')
	})

	it('ignores an empty board id', async () => {
		const boards = await loadModule()
		const before = boards.getLocalBoardsState().get()
		boards.adoptBoard('   ')
		expect(boards.getLocalBoardsState().get()).toEqual(before)
	})

	it('builds an invite link carrying the board id and name', async () => {
		const boards = await loadModule()
		boards.renameBoard(boards.getCurrentBoard().id, 'Design review')
		const url = new URL(boards.getBoardInviteUrl('https://example.test'))
		expect(url.origin).toBe('https://example.test')
		expect(url.searchParams.get('board')).toBe(boards.getCurrentBoard().id)
		expect(url.searchParams.get('name')).toBe('Design review')
	})

	it('falls back to a fresh bootstrap when the stored state is corrupt', async () => {
		window.localStorage.setItem(STORAGE_KEY, '{ not json')
		const boards = await loadModule()
		expect(boards.getLocalBoardsState().get().boards).toHaveLength(1)
	})

	it('falls back when the stored current board no longer exists', async () => {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				workspaces: [{ id: 'w1', name: 'W' }],
				boards: [{ id: 'b1', name: 'B', workspaceId: 'w1' }],
				currentBoardId: 'gone',
			})
		)
		const boards = await loadModule()
		const state = boards.getLocalBoardsState().get()
		expect(state.boards.map((b) => b.id)).not.toContain('b1')
	})
})
