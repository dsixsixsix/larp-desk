import classNames from 'classnames'
import { DropdownMenu as _DropdownMenu } from 'radix-ui'
import { useCallback } from 'react'
import { useContainer, useGlobalMenuIsOpen, useMaybeEditor, useValue } from 'tldraw'
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId'
import { useApp } from '../../hooks/useAppState'
import { getBoardAccentVar } from '../../utils/boardAccent'
import { defineMessages, useMsg } from '../../utils/i18n'
import { TLA_MENU_POSITION } from '../tla-menu/tla-menu'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import { TlaWorkspaceMenuItems } from '../TlaWorkspaceMenu/TlaWorkspaceMenuItems'
import sidebarStyles from '../TlaSidebar/sidebar.module.css'
import styles from './top.module.css'

const messages = defineMessages({
	myWorkspace: { defaultMessage: 'My workspace' },
	workspaceMenu: { defaultMessage: 'Workspace menu' },
})

/**
 * The workspace half of the editor's breadcrumb: which workspace the open board belongs to,
 * and the menu for switching workspace or adding to one. It repeats the sidebar's switcher on
 * purpose — the sidebar can be collapsed or off-screen, and the board's location should never
 * depend on that.
 */
export function TlaEditorWorkspaceBreadcrumb() {
	const app = useApp()
	const activeWorkspaceId = useActiveWorkspaceId()
	const myWorkspaceLbl = useMsg(messages.myWorkspace)
	const menuLbl = useMsg(messages.workspaceMenu)
	const container = useContainer()

	const activeWorkspaceName = useValue(
		'active workspace name',
		() => app.getWorkspaceMembership(activeWorkspaceId)?.group?.name,
		[app, activeWorkspaceId]
	)

	// Keyed globally rather than per-editor, for the same reason as the sidebar switcher:
	// switching workspace replaces the editor, which would otherwise dismiss this menu mid-switch.
	const editor = useMaybeEditor()
	const [isOpen, onOpenChange] = useGlobalMenuIsOpen(
		'editor-workspace-breadcrumb',
		useCallback(
			(nextIsOpen: boolean) => {
				if (nextIsOpen) editor?.complete()
			},
			[editor]
		)
	)

	return (
		<_DropdownMenu.Root open={isOpen} onOpenChange={onOpenChange}>
			<_DropdownMenu.Trigger asChild>
				<button
					className={classNames(styles.topLeftWorkspaceTrigger, 'tla-text_ui__regular')}
					data-testid="tla-top-workspace-breadcrumb"
					title={menuLbl}
					aria-label={menuLbl}
				>
					<span
						className={styles.topLeftWorkspaceSwatch}
						style={{ backgroundColor: getBoardAccentVar(activeWorkspaceId) }}
						aria-hidden
					/>
					<span
						className={classNames(styles.topLeftWorkspaceName, 'notranslate')}
						data-testid="tla-top-workspace-name"
					>
						{activeWorkspaceName ?? myWorkspaceLbl}
					</span>
					<TlaIcon icon="chevron-down" className={styles.topLeftWorkspaceChevron} />
				</button>
			</_DropdownMenu.Trigger>
			<_DropdownMenu.Portal container={container}>
				<_DropdownMenu.Content
					className={classNames('tlui-menu', sidebarStyles.sidebarWorkspaceSwitcherMenu)}
					side="bottom"
					align="start"
					{...TLA_MENU_POSITION}
					onCloseAutoFocus={(e) => {
						if (editor?.menus.hasAnyOpenMenus()) e.preventDefault()
					}}
				>
					<TlaWorkspaceMenuItems source="file-header" />
				</_DropdownMenu.Content>
			</_DropdownMenu.Portal>
		</_DropdownMenu.Root>
	)
}
