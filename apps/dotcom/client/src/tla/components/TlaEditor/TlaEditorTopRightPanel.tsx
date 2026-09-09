import {
	commentsSidebarOpen,
	toggleCommentsSidebar,
	useCommentingEnabled,
	useCommentsSidebarOpen,
} from '@tldraw/commenting'
import {
	PUBLISH_PREFIX,
	READ_ONLY_LEGACY_PREFIX,
	READ_ONLY_PREFIX,
	ROOM_PREFIX,
	SNAPSHOT_PREFIX,
} from '@tldraw/dotcom-shared'
import { useCallback, useRef } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
	PeopleMenu,
	TldrawUiButton,
	useEditor,
	usePassThroughWheelEvents,
	useTranslation,
} from 'tldraw'
import { routes } from '../../../routeDefs'
import { useMaybeApp } from '../../hooks/useAppState'
import { useCurrentFileId } from '../../hooks/useCurrentFileId'
import { useIsCommentingEnabled } from '../../hooks/useIsCommentingEnabled'
import { useTldrawAppUiEvents } from '../../utils/app-ui-events'
import { defineMessages, F, useMsg } from '../../utils/i18n'
import { TlaActivityLogButton } from '../TlaActivityLog/TlaActivityLogButton'
import { TlaBoardParticipants } from '../TlaBoardPresence/TlaBoardParticipants'
import { TlaVoiceChatButton } from '../TlaBoardPresence/TlaVoiceChatButton'
import { TlaCtaButton } from '../TlaCtaButton/TlaCtaButton'
import { TlaFileShareMenu } from '../TlaFileShareMenu/TlaFileShareMenu'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import {
	TlaAccountButton,
	TlaLocalAccountButton,
	TlaThemeToggleButton,
	TlaUnoAdminButton,
} from './TlaEditorAccountControls'
import styles from './top.module.css'

const commentsMessages = defineMessages({
	comments: { defaultMessage: 'Comments' },
})

export function TlaEditorTopRightPanel({
	isAnonUser,
	context,
}: {
	isAnonUser: boolean
	context: 'file' | 'published-file' | 'scratch' | 'legacy'
}) {
	const ref = useRef<HTMLDivElement>(null)
	usePassThroughWheelEvents(ref)
	const fileId = useCurrentFileId()
	const trackEvent = useTldrawAppUiEvents()
	const editor = useEditor()
	// Share and the comments sidebar are mutually exclusive: opening share closes the sidebar.
	// (The reverse is automatic — clicking the sidebar button dismisses the share popover as an
	// outside interaction.)
	const closeSidebarOnShareOpen = useCallback(
		(isOpen: boolean) => {
			if (isOpen) commentsSidebarOpen.set(editor, false)
		},
		[editor]
	)

	if (isAnonUser) {
		// Sharing is an invite from the workspace switcher rather than a share menu, so this is the
		// theme toggle, the profile button, and — for the admin only — the member list.
		return (
			<div ref={ref} className={styles.topRightPanel}>
				<TlaBoardParticipants />
				<TlaVoiceChatButton />
				<PeopleMenu />
				<TlaActivityLogButton />
				<TlaUnoAdminButton />
				<TlaThemeToggleButton />
				<TlaLocalAccountButton />
			</div>
		)
	}

	return (
		<div ref={ref} className={styles.topRightPanel}>
			<PeopleMenu />
			{/* Only file editors mount the comments sidebar (see CommentsOnCanvas); in legacy and
			    published contexts the button would toggle state nothing reads. */}
			{context !== 'legacy' && context !== 'published-file' && <CommentsSidebarButton />}
			{context === 'legacy' && <LegacyImportButton />}
			{context !== 'legacy' && (
				<TlaFileShareMenu
					fileId={fileId!}
					source="file-header"
					context={context}
					onOpenChange={closeSidebarOnShareOpen}
				>
					<TlaCtaButton
						canvas
						data-testid="tla-share-button"
						onClick={() => trackEvent('open-share-menu', { source: 'top-bar' })}
					>
						<F defaultMessage="Share" />
					</TlaCtaButton>
				</TlaFileShareMenu>
			)}
			<TlaThemeToggleButton />
			<TlaAccountButton />
		</div>
	)
}

/**
 * Toggles the comments sidebar (the thread list) open and closed. Lives next to Share as an opt-in
 * entry point, decoupled from the comment tool: the tool places comments on the canvas, this button
 * reveals the list. Hidden entirely when commenting isn't licensed for this editor, or when the
 * user isn't covered by dotcom's commenting flag.
 */
function CommentsSidebarButton() {
	const editor = useEditor()
	const trackEvent = useTldrawAppUiEvents()
	const commentingEnabled = useCommentingEnabled()
	const commentingEnabledForUser = useIsCommentingEnabled()
	const open = useCommentsSidebarOpen()
	const label = useMsg(commentsMessages.comments)

	if (!commentingEnabled || !commentingEnabledForUser) return null

	return (
		<TldrawUiButton
			type="icon"
			className={styles.commentsSidebarButton}
			data-testid="tla-comments-button"
			aria-pressed={open}
			tooltip={label}
			title={label}
			onClick={() => {
				toggleCommentsSidebar(editor)
				trackEvent('toggle-comments-sidebar', { source: 'comments', open: !open })
			}}
		>
			<TlaIcon icon="comment" />
		</TldrawUiButton>
	)
}

export function useGetFileName() {
	const editor = useEditor()
	const msg = useTranslation()
	const defaultPageName = msg('page-menu.new-page-initial-name')

	const documentName = editor.getDocumentSettings().name
	if (documentName?.length > 0) return documentName

	const firstPageName = editor.getPages()[0].name
	if (
		firstPageName.length > 0 &&
		!firstPageName.startsWith('Page 1') &&
		!firstPageName.startsWith(defaultPageName)
	)
		return firstPageName
	return ''
}

function usePrefix() {
	const location = useLocation()
	const roomPrefix = location.pathname.split('/')[1]
	switch (roomPrefix) {
		case ROOM_PREFIX:
		case READ_ONLY_PREFIX:
		case READ_ONLY_LEGACY_PREFIX:
		case SNAPSHOT_PREFIX:
		case PUBLISH_PREFIX:
			return roomPrefix
	}
	return null
}

export function useRoomInfo() {
	const id = useParams()['roomId'] as string
	const prefix = usePrefix()
	if (!id || !prefix) return null
	return { prefix, id }
}

function LegacyImportButton() {
	const trackEvent = useTldrawAppUiEvents()
	const app = useMaybeApp()
	const editor = useEditor()
	const navigate = useNavigate()
	const name = useGetFileName()
	const roomInfo = useRoomInfo()

	const handleClick = useCallback(async () => {
		if (!app || !editor || !roomInfo) return

		const { prefix, id } = roomInfo
		const res = await app.createFile({ name, createSource: `${prefix}/${id}` })
		if (res.ok) {
			const { fileId } = res.value
			navigate(routes.tlaFile(fileId))
			trackEvent('create-file', { source: 'legacy-import-button' })
		}
	}, [app, editor, name, navigate, roomInfo, trackEvent])

	return (
		<TlaCtaButton canvas data-testid="tla-import-button" onClick={handleClick}>
			<F defaultMessage="Copy to my workspace" />
		</TlaCtaButton>
	)
}
