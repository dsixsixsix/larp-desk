import classNames from 'classnames'
import { DropdownMenu as _DropdownMenu } from 'radix-ui'
import { ReactNode } from 'react'
import { useValue } from 'tldraw'
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId'
import { useApp } from '../../hooks/useAppState'
import {
	useCreateFileInActiveWorkspace,
	useCreateWorkspaceDialog,
	useSwitchToWorkspace,
} from '../../hooks/useWorkspaceNavigation'
import { TLAppUiEventSource } from '../../utils/app-ui-events'
import { getBoardAccentVar } from '../../utils/boardAccent'
import { defineMessages, useMsg } from '../../utils/i18n'
import { TlaIcon } from '../TlaIcon/TlaIcon'
// The sidebar switcher and the editor breadcrumb are the same menu shown from two triggers,
// so they share these styles rather than each keeping a copy that can drift.
import styles from '../TlaSidebar/sidebar.module.css'

const messages = defineMessages({
	myWorkspace: { defaultMessage: 'My workspace' },
	createWorkspace: { defaultMessage: 'New workspace' },
	createFile: { defaultMessage: 'New board' },
})

/**
 * The body of the workspace menu: switch workspace, add a board to the one you're in, or
 * start a new workspace. Rendered inside a radix `DropdownMenu.Content` by whichever trigger
 * opened it — the sidebar's switcher or the editor's breadcrumb.
 */
export function TlaWorkspaceMenuItems({ source }: { source: TLAppUiEventSource }) {
	const app = useApp()
	const homeWorkspaceId = app.getHomeWorkspaceId()
	const activeWorkspaceId = useActiveWorkspaceId()
	const myWorkspaceLbl = useMsg(messages.myWorkspace)
	const createWorkspaceLbl = useMsg(messages.createWorkspace)
	const createFileLbl = useMsg(messages.createFile)

	const workspaces = useValue(
		'workspaceMemberships',
		() =>
			app
				.getWorkspaceMemberships()
				.filter(
					(g): g is typeof g & { group: NonNullable<(typeof g)['group']> } =>
						g.groupId !== homeWorkspaceId && !!g.group
				),
		[app, homeWorkspaceId]
	)
	const homeWorkspaceName = useValue(
		'home workspace name',
		() => app.getWorkspaceMembership(homeWorkspaceId)?.group?.name,
		[app, homeWorkspaceId]
	)

	const switchToWorkspace = useSwitchToWorkspace()
	const handleCreateWorkspace = useCreateWorkspaceDialog(source)
	const handleCreateFile = useCreateFileInActiveWorkspace(source)

	return (
		<>
			<WorkspaceSwitcherItem
				isActive={activeWorkspaceId === homeWorkspaceId}
				workspaceId={homeWorkspaceId}
				onSelect={() => switchToWorkspace(homeWorkspaceId)}
				testId="tla-workspace-switcher-home"
			>
				{homeWorkspaceName ?? myWorkspaceLbl}
			</WorkspaceSwitcherItem>
			{workspaces.map((g) => (
				<WorkspaceSwitcherItem
					key={`workspace-${g.group.id}`}
					isActive={g.group.id === activeWorkspaceId}
					workspaceId={g.group.id}
					onSelect={() => switchToWorkspace(g.group.id)}
				>
					{g.group.name}
				</WorkspaceSwitcherItem>
			))}
			<_DropdownMenu.Separator className={styles.sidebarWorkspaceSwitcherSeparator} />
			<_DropdownMenu.Item
				className={classNames(
					styles.sidebarWorkspaceSwitcherItem,
					styles.sidebarWorkspaceSwitcherItemCreate,
					'tla-text_ui__regular'
				)}
				onSelect={handleCreateFile}
				data-testid="tla-create-file-menu-item"
			>
				<span className={styles.sidebarWorkspaceSwitcherItemLabel}>
					<TlaIcon icon="edit-strong" />
					<span className={styles.sidebarTruncatedText}>{createFileLbl}</span>
				</span>
			</_DropdownMenu.Item>
			<_DropdownMenu.Item
				className={classNames(
					styles.sidebarWorkspaceSwitcherItem,
					styles.sidebarWorkspaceSwitcherItemCreate,
					'tla-text_ui__regular'
				)}
				onSelect={handleCreateWorkspace}
				data-testid="tla-create-workspace-menu-item"
			>
				<span className={styles.sidebarWorkspaceSwitcherItemLabel}>
					<TlaIcon icon="plus" />
					<span className={styles.sidebarTruncatedText}>{createWorkspaceLbl}</span>
				</span>
			</_DropdownMenu.Item>
		</>
	)
}

function WorkspaceSwitcherItem({
	isActive,
	workspaceId,
	onSelect,
	testId,
	children,
}: {
	isActive: boolean
	workspaceId: string
	onSelect(): void
	testId?: string
	children: ReactNode
}) {
	return (
		<_DropdownMenu.Item
			className={classNames(
				styles.sidebarWorkspaceSwitcherItem,
				'tla-text_ui__regular',
				'notranslate'
			)}
			data-active={isActive}
			data-element="workspace-link"
			onSelect={onSelect}
			data-testid={testId}
		>
			<span className={styles.sidebarWorkspaceSwitcherItemLabel}>
				<TlaIcon icon={isActive ? 'check' : 'none'} />
				<span
					className={styles.sidebarWorkspaceSwatch}
					style={{ backgroundColor: getBoardAccentVar(workspaceId) }}
					aria-hidden
				/>
				<span className={styles.sidebarTruncatedText}>{children}</span>
			</span>
		</_DropdownMenu.Item>
	)
}
