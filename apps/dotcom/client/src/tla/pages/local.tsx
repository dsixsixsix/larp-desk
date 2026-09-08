import { useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { assert, getFromSessionStorage, omit, react, useValue } from 'tldraw'
import { LocalEditor } from '../../components/LocalEditor'
import { routes } from '../../routeDefs'
import { globalEditor } from '../../utils/globalEditor'
import { TlaAnonDotDevLink } from '../components/TlaAnonDotDevLink/TlaAnonDotDevLink'
import { SneakyDarkModeSync } from '../components/TlaEditor/sneaky/SneakyDarkModeSync'
import { SneakyDebugModeToast } from '../components/TlaEditor/sneaky/SneakyDebugModeToast'
import { components } from '../components/TlaEditor/TlaEditor'
import { TlaIdentityGate, useLocalIdentity } from '../components/TlaIdentityGate/TlaIdentityGate'
import { useMaybeApp } from '../hooks/useAppState'
import { TlaAnonLayout } from '../layouts/TlaAnonLayout/TlaAnonLayout'
import { TlaBoardSessionProvider } from '../providers/TlaBoardSessionProvider'
import { importFromUrl } from '../utils/importFromUrl'
import { adoptBoard, getLocalBoardsState } from '../utils/localBoards'
import { clearRedirectOnSignIn } from '../utils/redirect'
import { SESSION_STORAGE_KEYS } from '../utils/session-storage'
import { clearShouldSlurpFile, getShouldSlurpFile, setShouldSlurpFile } from '../utils/slurping'

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

function LocalTldraw() {
	const [identity, setIdentity] = useLocalIdentity()
	useAdoptBoardFromLink()
	const currentBoardId = useValue(
		'local-current-board-id',
		() => getLocalBoardsState().get().currentBoardId,
		[]
	)

	if (!identity) {
		return (
			<TlaAnonLayout>
				<TlaIdentityGate onDone={setIdentity} />
			</TlaAnonLayout>
		)
	}

	return (
		<TlaAnonLayout>
			{/* Keyed on the board too: switching boards ends the previous session outright rather
			    than leaving its websocket and peer connections running in the background. */}
			<TlaBoardSessionProvider
				key={currentBoardId}
				boardId={currentBoardId}
				userName={identity.name}
			>
				<LocalEditor
					key={currentBoardId}
					data-testid="tla-editor"
					persistenceKey={currentBoardId}
					components={components}
					onMount={(editor) => {
						editor.user.updateUserPreferences({ name: identity.name })
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

/**
 * Opens the board named in `?board=<id>` — how someone joins from a shared link (see
 * getBoardInviteUrl). The parameter is stripped once it has been used so a later reload doesn't
 * yank the user back to that board after they've navigated elsewhere.
 */
function useAdoptBoardFromLink() {
	const [searchParams, setSearchParams] = useSearchParams()
	const boardId = searchParams.get('board')
	const boardName = searchParams.get('name')

	useEffect(() => {
		if (!boardId) return
		adoptBoard(boardId, boardName ?? undefined)
		const next = new URLSearchParams(searchParams)
		next.delete('board')
		next.delete('name')
		setSearchParams(next, { replace: true })
	}, [boardId, boardName, searchParams, setSearchParams])
}
