import { UnoDirectoryBoard, UnoDirectoryWorkspace } from '@tldraw/dotcom-shared'
import { useValue } from 'tldraw'
import { UnoSessionState, getUnoCurrentBoardId, getUnoSessionState } from '../utils/unoDirectory'

export function useUnoSession(): UnoSessionState {
	return useValue('uno-session', () => getUnoSessionState().get(), [])
}

/** The signed-in user, or null while loading or signed out. */
export function useUnoUser() {
	const session = useUnoSession()
	return session.status === 'ready' ? session.directory.user : null
}

export function useIsUnoAdmin(): boolean {
	return useUnoUser()?.isAdmin === true
}

export function useUnoWorkspaces(): UnoDirectoryWorkspace[] {
	const session = useUnoSession()
	return session.status === 'ready' ? session.directory.workspaces : []
}

export function useUnoCurrentBoardId(): string | null {
	return useValue('uno-current-board', () => getUnoCurrentBoardId().get(), [])
}

/** The open board and the workspace it belongs to, or nulls when the directory is empty. */
export function useUnoCurrentBoard(): {
	board: UnoDirectoryBoard | null
	workspace: UnoDirectoryWorkspace | null
} {
	const workspaces = useUnoWorkspaces()
	const boardId = useUnoCurrentBoardId()
	for (const workspace of workspaces) {
		const board = workspace.boards.find((b) => b.id === boardId)
		if (board) return { board, workspace }
	}
	return { board: null, workspace: null }
}
