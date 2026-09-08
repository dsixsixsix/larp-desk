import classNames from 'classnames'
import { DropdownMenu as _DropdownMenu } from 'radix-ui'
import { useCallback } from 'react'
import { useContainer, useGlobalMenuIsOpen, useMaybeEditor, useValue } from 'tldraw'
import { useActiveWorkspaceId } from '../../../hooks/useActiveWorkspaceId'
import { useApp } from '../../../hooks/useAppState'
import { getBoardAccentVar } from '../../../utils/boardAccent'
import { defineMessages, useMsg } from '../../../utils/i18n'
import { TLA_MENU_POSITION } from '../../tla-menu/tla-menu'
import { TlaIcon } from '../../TlaIcon/TlaIcon'
import { TlaWorkspaceMenuItems } from '../../TlaWorkspaceMenu/TlaWorkspaceMenuItems'
import styles from '../sidebar.module.css'

const messages = defineMessages({
	myWorkspace: { defaultMessage: 'My workspace' },
})

/**
 * The fixed top region of the sidebar: a dropdown for switching between the
 * home workspace and the user's other workspaces, followed by action rows for
 * the active workspace. Selecting a workspace opens the file the user most
 * recently had open in it (or its top file if they've visited none), which makes
 * it active (the active workspace is derived from the open file).
 */
export function TlaSidebarWorkspaceSwitcher() {
	const app = useApp()
	const activeWorkspaceId = useActiveWorkspaceId()
	const myWorkspaceLbl = useMsg(messages.myWorkspace)

	const activeWorkspaceName = useValue(
		'active workspace name',
		() => app.getWorkspaceMembership(activeWorkspaceId)?.group?.name,
		[app, activeWorkspaceId]
	)

	// Use a stable, editor-independent menu id. useMenuIsOpen would suffix the id
	// with the active file editor's contextId, but the sidebar receives that editor
	// via globalEditor and it is replaced on every file/workspace switch. That made
	// the switcher's open state churn with — and get cleared by the dispose of — the
	// outgoing editor, so reopening it mid-switch auto-dismissed once the new canvas loaded.
	// We still complete any in-progress canvas interaction on open (the one useful side
	// effect useMenuIsOpen gave us) by running it against the current editor, without
	// scoping the menu state itself to that editor.
	const editor = useMaybeEditor()
	const [isOpen, onOpenChange] = useGlobalMenuIsOpen(
		'sidebar-workspace-switcher',
		useCallback(
			(nextIsOpen: boolean) => {
				if (nextIsOpen) editor?.complete()
			},
			[editor]
		)
	)
	const container = useContainer()

	return (
		<div className={styles.sidebarSection}>
			<div className={styles.sidebarWorkspaceSwitcherRoot}>
				<_DropdownMenu.Root open={isOpen} onOpenChange={onOpenChange}>
					<_DropdownMenu.Trigger asChild>
						<button
							className={classNames(
								styles.sidebarWorkspaceSwitcherTrigger,
								styles.hoverable,
								'tla-text_ui__regular'
							)}
							data-testid="tla-workspace-switcher"
						>
							<span
								className={styles.sidebarWorkspaceSwatch}
								style={{ backgroundColor: getBoardAccentVar(activeWorkspaceId) }}
								aria-hidden
							/>
							<span
								className={classNames(styles.sidebarWorkspaceSwitcherLabel, 'notranslate')}
								data-testid="tla-active-workspace-name"
							>
								{activeWorkspaceName ?? myWorkspaceLbl}
							</span>
							<TlaIcon icon="chevron-up-down" className={styles.sidebarWorkspaceSwitcherChevrons} />
						</button>
					</_DropdownMenu.Trigger>
					<_DropdownMenu.Portal container={container}>
						<_DropdownMenu.Content
							className={classNames('tlui-menu', styles.sidebarWorkspaceSwitcherMenu)}
							side="bottom"
							align="start"
							{...TLA_MENU_POSITION}
							// When the switcher closes because another menu is opening (e.g. a file's
							// "…" menu), don't restore focus to our trigger — that focus shift would
							// dismiss the just-opened menu, making it flash. A plain Escape/outside
							// close (no other menu open) still restores focus for keyboard users.
							onCloseAutoFocus={(e) => {
								if (editor?.menus.hasAnyOpenMenus()) e.preventDefault()
							}}
						>
							<TlaWorkspaceMenuItems source="sidebar" />
						</_DropdownMenu.Content>
					</_DropdownMenu.Portal>
				</_DropdownMenu.Root>
			</div>
		</div>
	)
}
