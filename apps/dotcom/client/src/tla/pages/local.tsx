import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { assert, getFromSessionStorage, omit, react } from 'tldraw'
import { LocalEditor } from '../../components/LocalEditor'
import { routes } from '../../routeDefs'
import { globalEditor } from '../../utils/globalEditor'
import { TlaAnonDotDevLink } from '../components/TlaAnonDotDevLink/TlaAnonDotDevLink'
import { SneakyDarkModeSync } from '../components/TlaEditor/sneaky/SneakyDarkModeSync'
import { SneakyDebugModeToast } from '../components/TlaEditor/sneaky/SneakyDebugModeToast'
import { components } from '../components/TlaEditor/TlaEditor'
import {
	TlaEmptyDirectoryGate,
	TlaNoAccessGate,
} from '../components/TlaIdentityGate/TlaIdentityGate'
import { useMaybeApp } from '../hooks/useAppState'
import { useUnoCurrentBoard, useUnoSession } from '../hooks/useUnoDirectory'
import { TlaAnonLayout } from '../layouts/TlaAnonLayout/TlaAnonLayout'
import { TlaBoardSessionProvider } from '../providers/TlaBoardSessionProvider'
import { importFromUrl } from '../utils/importFromUrl'
import { clearRedirectOnSignIn } from '../utils/redirect'
import { SESSION_STORAGE_KEYS } from '../utils/session-storage'
import { clearShouldSlurpFile, getShouldSlurpFile, setShouldSlurpFile } from '../utils/slurping'
import { loadUnoDirectory } from '../utils/unoDirectory'

export function Component() {
	const app = useMaybeApp()
	const navigate = useNavigate()
	const location = useLocation()

	useEffect(() => {
		const handleFileOperations = async () => {
			if (!app) return

			// Check for redirect-to first (set by OAuth sign-in)
			const redirectTo = getFromSessionStorage(SESSION_STORAGE_KEYS.REDIRECT)
			if (redirectTo) {
				clearRedirectOnSignIn()
				if (redirectTo.startsWith('/')) {
					navigate(redirectTo, { replace: true })
					return
				}
			}

			// Run pending import from URL (set by /import?url=... redirect)
			const pendingImportUrl = location.state?.importUrl
			if (pendingImportUrl) {
				// need to remove importUrl from location state so it doesn't persist after the import
				const state = omit(location.state, ['importUrl'])
				const result = await importFromUrl(app, pendingImportUrl)
				if (result.ok) {
					navigate(routes.tlaFile(result.fileId), {
						replace: true,
						state,
					})
					return
				} else {
					// just update the state without navigating anywhere
					navigate('.', { replace: true, state })
				}
				if (!result.toastAlreadyShown) {
					app.toasts?.addToast({
						severity: 'error',
						title: 'Import failed',
						description: result.error,
						keepOpen: true,
					})
				}
				return
			}

			if (getShouldSlurpFile()) {
				const res = await app.slurpFile()
				if (res.ok) {
					clearShouldSlurpFile()
					navigate(routes.tlaFile(res.value.fileId), {
						replace: true,
						state: location.state,
					})
					return
				} else {
					// if the user has too many files we end up here.
					// don't slurp the file and when they log out they'll
					// be able to see the same content that was there before
				}
			}

			// Land on the file the user last had open, across all workspaces, not just home.
			const mostRecentFileId = app.getMostRecentFileId()
			if (!mostRecentFileId) {
				const result = await app.createFile()

				assert(result.ok, 'Failed to create file')
				// result is only false if the user reached their file limit so
				// we don't need to handle that case here since they have no files
				if (result.ok) {
					navigate(routes.tlaFile(result.value.fileId), {
						replace: true,
						state: location.state,
					})
				}
				return
			}

			navigate(routes.tlaFile(mostRecentFileId), { replace: true, state: location.state })
		}

		handleFileOperations()
	}, [app, navigate, location])

	if (!app) return <LocalTldraw />

	// navigation will be handled by the useEffect above
	return null
}

/**
 * The app for a signed-in browser: one board at a time, chosen from what the directory says this
 * person may open (see unoDirectory.ts). Board contents are still local — the id is the tldraw
 * persistence key — but the id itself now comes from the server, and a board that is not in the
 * directory cannot be reached by knowing it.
 */
function LocalTldraw() {
	const session = useUnoSession()
	const { board } = useUnoCurrentBoard()

	useEffect(() => {
		loadUnoDirectory()
	}, [])

	if (session.status === 'loading') {
		// Blank rather than a spinner: the directory usually resolves within a frame or two, and a
		// spinner that appears and vanishes reads as a fault.
		return <div className="tldraw__editor" />
	}

	if (session.status === 'signed-out') {
		return (
			<TlaAnonLayout>
				<TlaNoAccessGate />
			</TlaAnonLayout>
		)
	}

	if (!board) {
		return (
			<TlaAnonLayout>
				<TlaEmptyDirectoryGate isAdmin={session.directory.user.isAdmin} />
			</TlaAnonLayout>
		)
	}

	const userName = session.directory.user.name

	return (
		<TlaAnonLayout>
			{/* Keyed on the board too: switching boards ends the previous session outright rather
			    than leaving its websocket and peer connections running in the background. */}
			<TlaBoardSessionProvider key={board.id} boardId={board.id} userName={userName}>
				<LocalEditor
					key={board.id}
					data-testid="tla-editor"
					persistenceKey={board.id}
					components={components}
					onMount={(editor) => {
						editor.user.updateUserPreferences({ name: userName })
						globalEditor.set(editor)
						const shapes$ = editor.store.query.ids('shape')

						return react('updateShouldSlurpFile', () => {
							if (shapes$.get().size > 0) {
								setShouldSlurpFile()
							} else {
								clearShouldSlurpFile()
							}
						})
					}}
					options={{ actionShortcutsLocation: 'toolbar' }}
				>
					<SneakyDarkModeSync />
					<SneakyDebugModeToast />
					<TlaAnonDotDevLink />
				</LocalEditor>
			</TlaBoardSessionProvider>
		</TlaAnonLayout>
	)
}
