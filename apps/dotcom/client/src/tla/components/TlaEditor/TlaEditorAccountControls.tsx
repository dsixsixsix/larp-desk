import { TldrawUiButton, useDialogs, useEditor, useValue } from 'tldraw'
import { useApp } from '../../hooks/useAppState'
import { useIsUnoAdmin, useUnoUser } from '../../hooks/useUnoDirectory'
import { useTldrawAppUiEvents } from '../../utils/app-ui-events'
import { defineMessages, useMsg } from '../../utils/i18n'
import { updateLocalSessionState } from '../../utils/local-session-state'
import { TlaAccountDialog } from '../dialogs/TlaAccountDialog'
import { TlaAdminMembersDialog } from '../dialogs/TlaAdminMembersDialog'
import { TlaLocalAccountDialog } from '../dialogs/TlaLocalAccountDialog'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import styles from './top.module.css'

const messages = defineMessages({
	account: { defaultMessage: 'Account' },
	people: { defaultMessage: 'People' },
	switchToDark: { defaultMessage: 'Switch to dark theme' },
	switchToLight: { defaultMessage: 'Switch to light theme' },
})

/**
 * A one-click light/dark switch, next to the account button.
 *
 * It writes an explicit `colorScheme` rather than toggling a local flag, so the choice rides on
 * the same user preferences everything else reads: it persists across reloads (in the user
 * record when signed in, in local preferences when not) and the full three-way choice —
 * including "system" — stays available in the preferences menu.
 *
 * The app keeps a second, coarser theme of its own — the one that paints the shell around the
 * canvas — so the button sets both. Writing only the editor preference leaves the top bar, menus
 * and sidebar in the old theme until something else happens to sync them.
 */
export function TlaThemeToggleButton() {
	const editor = useEditor()
	const trackEvent = useTldrawAppUiEvents()
	const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
	const label = useMsg(isDark ? messages.switchToLight : messages.switchToDark)

	return (
		<TldrawUiButton
			type="icon"
			className={styles.topRightIconButton}
			data-testid="tla-theme-toggle"
			tooltip={label}
			title={label}
			onClick={() => {
				const colorScheme = isDark ? 'light' : 'dark'
				editor.user.updateUserPreferences({ colorScheme })
				updateLocalSessionState(() => ({ theme: colorScheme }))
				trackEvent('set-theme', { source: 'top-bar', theme: colorScheme })
			}}
		>
			{/* The icon shows the mode you'd switch to, matching the label. */}
			<TlaIcon icon={isDark ? 'sun' : 'moon'} />
		</TldrawUiButton>
	)
}

/** Opens the account panel: the name shown on the canvas, and the signed-in address. */
export function TlaAccountButton() {
	const app = useApp()
	const { addDialog } = useDialogs()
	const label = useMsg(messages.account)
	const userName = useValue('user name', () => app.getUser()?.name, [app])

	return (
		<TldrawUiButton
			type="icon"
			className={styles.topRightIconButton}
			data-testid="tla-account-button"
			tooltip={userName || label}
			title={userName || label}
			aria-label={label}
			onClick={() => {
				addDialog({ component: TlaAccountDialog })
			}}
		>
			<TlaIcon icon="avatar" />
		</TldrawUiButton>
	)
}

/**
 * The local (no-auth) equivalent of TlaAccountButton: opens TlaLocalAccountDialog, which shows the
 * name and email this browser joined with (see unoDirectory.ts).
 */
export function TlaLocalAccountButton() {
	const { addDialog } = useDialogs()
	const label = useMsg(messages.account)
	const identity = useUnoUser()

	return (
		<TldrawUiButton
			type="icon"
			className={styles.topRightIconButton}
			data-testid="tla-local-account-button"
			tooltip={identity?.name || label}
			title={identity?.name || label}
			aria-label={label}
			onClick={() => {
				addDialog({ component: TlaLocalAccountDialog })
			}}
		>
			<TlaIcon icon="avatar" />
		</TldrawUiButton>
	)
}

/**
 * The admin's way into the member list: who has been invited, where they can go, and the links
 * that got them there (see TlaAdminMembersDialog). Absent for everyone else, because there is
 * nothing behind it they are allowed to see.
 */
export function TlaUnoAdminButton() {
	const { addDialog } = useDialogs()
	const isAdmin = useIsUnoAdmin()
	const label = useMsg(messages.people)

	if (!isAdmin) return null

	return (
		<TldrawUiButton
			type="icon"
			className={styles.topRightIconButton}
			data-testid="tla-admin-people-button"
			tooltip={label}
			title={label}
			aria-label={label}
			onClick={() => {
				addDialog({ component: TlaAdminMembersDialog })
			}}
		>
			<TlaIcon icon="group" />
		</TldrawUiButton>
	)
}
