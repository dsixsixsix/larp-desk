import { useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { tltime, uniqueId, useDialogs } from 'tldraw'
import { routes } from '../../routeDefs'
import { CreateWorkspaceDialog } from '../components/dialogs/CreateWorkspaceDialog'
import { TLAppUiEventSource, useTldrawAppUiEvents } from '../utils/app-ui-events'
import { getIsCoarsePointer } from '../utils/getIsCoarsePointer'
import { toggleMobileSidebar } from '../utils/local-session-state'
import { useActiveWorkspaceId } from './useActiveWorkspaceId'
import { useApp } from './useAppState'

/**
 * Workspace-level navigation, shared by every surface that offers it: the sidebar's
 * switcher and the editor's breadcrumb. One implementation, because "switch workspace"
 * has to make the same in-flight-seed and empty-workspace decisions wherever it is
 * invoked — two copies would drift into creating duplicate blank files.
 */

/** Opens a workspace by navigating to a file inside it (the active workspace is derived from
 *  the open file, so there is no separate selection to set). */
export function useSwitchToWorkspace() {
	const app = useApp()
	const navigate = useNavigate()

	return useCallback(
		async (workspaceId: string) => {
			// Open the file the user last had open here, not just the top of the pinned-first list.
			const mostRecentFileId = app.getMostRecentFileId(workspaceId)
			if (mostRecentFileId) {
				navigate(routes.tlaFile(mostRecentFileId))
				return
			}
			// A workspace created moments ago may still be seeding its welcome file: the
			// createWorkspace mutation lands before the file does, so it briefly appears empty.
			// Await that in-flight seed and open its result rather than racing it with a duplicate
			// blank file. (On seed failure we fall through to the blank-file path below.)
			const pendingWelcome = app.getPendingWorkspaceWelcomeFile(workspaceId)
			if (pendingWelcome) {
				const seeded = await pendingWelcome
				if (seeded.ok) {
					navigate(routes.tlaFile(seeded.value.fileId))
					return
				}
			}
			// Empty workspace: create a blank file and open it, so selecting a workspace always
			// lands you on a file within it. The welcome file is seeded only when a workspace is
			// first created (see useCreateWorkspaceDialog), so an emptied workspace — like the
			// home workspace — just gets a fresh blank file to rename, not another welcome doc.
			const res = await app.createFile({ workspaceId })
			if (res.ok) {
				if (!getIsCoarsePointer()) {
					app.sidebarState.update((prev) => ({
						...prev,
						renameState: { fileId: res.value.fileId, workspaceId },
					}))
				}
				navigate(routes.tlaFile(res.value.fileId))
			}
		},
		[app, navigate]
	)
}

/** Prompts for a name, creates the workspace, and lands the user inside it. */
export function useCreateWorkspaceDialog(source: TLAppUiEventSource) {
	const app = useApp()
	const navigate = useNavigate()
	const { addDialog } = useDialogs()
	const switchToWorkspace = useSwitchToWorkspace()
	const trackEvent = useTldrawAppUiEvents()

	return useCallback(() => {
		addDialog({
			component: ({ onClose }) => (
				<CreateWorkspaceDialog
					onClose={onClose}
					onCreate={async (name) => {
						const id = uniqueId()
						const createRes = await app.z.mutate.createWorkspace({ id, name }).client
						if (createRes.type === 'error') {
							app.showMutationRejectionToast(createRes.error)
							return
						}
						trackEvent('create-workspace', { source })
						// Seed the workspace's welcome file once, here at creation, and open it
						// directly (not via switchToWorkspace, whose empty-workspace path would
						// otherwise create a blank file before the welcome file lands).
						const res = await app.createWorkspaceWelcomeFile(id)
						if (res.ok) {
							navigate(routes.tlaFile(res.value.fileId))
						} else {
							// Seeding failed; still land the user in the new workspace rather than
							// leaving them stranded. switchToWorkspace creates a blank file for the
							// (now empty) workspace and opens it.
							await switchToWorkspace(id)
						}
					}}
				/>
			),
		})
	}, [app, addDialog, navigate, switchToWorkspace, trackEvent, source])
}

/**
 * Creates a board in whichever workspace is currently active and opens it, dropping the
 * sidebar row straight into rename mode on pointer devices.
 */
export function useCreateFileInActiveWorkspace(source: TLAppUiEventSource) {
	const app = useApp()
	const navigate = useNavigate()
	const trackEvent = useTldrawAppUiEvents()
	const activeWorkspaceId = useActiveWorkspaceId()

	const rCanCreate = useRef(true)

	return useCallback(async () => {
		if (!rCanCreate.current) return
		const res = await app.createFile({ workspaceId: activeWorkspaceId })
		if (res.ok) {
			const isMobile = getIsCoarsePointer()
			if (!isMobile) {
				app.sidebarState.update((prev) => ({
					...prev,
					renameState: { fileId: res.value.fileId, workspaceId: activeWorkspaceId },
				}))
			}
			const { fileId } = res.value
			navigate(routes.tlaFile(fileId))
			trackEvent('create-file', { source })
			rCanCreate.current = false
			tltime.setTimeout('can create again', () => (rCanCreate.current = true), 1000)
			if (isMobile) {
				toggleMobileSidebar(false)
			}
		}
	}, [app, navigate, trackEvent, activeWorkspaceId, source])
}
