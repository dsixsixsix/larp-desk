import { UnoInviteScope } from '@tldraw/dotcom-shared'
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TldrawUiIcon, useContainer } from 'tldraw'
import { useIsUnoAdmin, useUnoCurrentBoard, useUnoWorkspaces } from '../../hooks/useUnoDirectory'
import { defineMessages, useIntl, useMsg } from '../../utils/i18n'
import {
	createUnoBoard,
	createUnoInviteUrl,
	createUnoWorkspace,
	deleteUnoBoard,
	deleteUnoWorkspace,
	renameUnoBoard,
	renameUnoWorkspace,
	setCurrentBoardId,
} from '../../utils/unoDirectory'
import styles from './workspace-switcher.module.css'

const messages = defineMessages({
	toggle: { defaultMessage: 'Switch workspace or board' },
	breadcrumb: { defaultMessage: '{workspace} / {board}' },
	workspaces: { defaultMessage: 'Workspaces' },
	boards: { defaultMessage: 'Boards' },
	newWorkspace: { defaultMessage: 'New workspace' },
	newBoard: { defaultMessage: 'New board' },
	workspaceNamePlaceholder: { defaultMessage: 'Workspace name' },
	boardNamePlaceholder: { defaultMessage: 'Board name' },
	create: { defaultMessage: 'Create' },
	cancel: { defaultMessage: 'Cancel' },
	inviteToWorkspace: { defaultMessage: 'Copy invite link to this workspace' },
	inviteToBoard: { defaultMessage: 'Copy invite link to this board' },
	copiedLink: { defaultMessage: 'Link copied' },
	inviteFailed: { defaultMessage: 'Could not create a link' },
	rename: { defaultMessage: 'Rename' },
	save: { defaultMessage: 'Save' },
	delete: { defaultMessage: 'Delete' },
	deleteBoardConfirm: { defaultMessage: 'Delete “{name}” and everything on it?' },
	deleteWorkspaceConfirm: {
		defaultMessage: 'Delete “{name}” and every board in it?',
	},
})

/**
 * "Workspace / board" label in the header, right of the board-outline sidebar toggle (see
 * TlaEditorTopPanel). Opens a panel listing what this person may open, and — for the admin — the
 * controls to create, rename and delete workspaces and boards, and to mint the invite links that
 * let anyone else in at all.
 *
 * Everyone else gets the same panel without those controls: a workspace is the group a board
 * belongs to, and the only way into either is a link the admin sent (see unoDirectory.ts).
 */
export function TlaWorkspaceSwitcher() {
	const [isOpen, setIsOpen] = useState(false)
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
	const buttonRef = useRef<HTMLButtonElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)
	const intl = useIntl()
	// Portalled out of the editor's DOM to escape the canvas's stacking context, but into the
	// themed container rather than <body>: the panel's colours come from theme variables scoped to
	// `.tla`/`.tl-theme__*`, which don't resolve on <body> (the panel renders fully transparent).
	const container = useContainer()
	const toggleLbl = useMsg(messages.toggle)
	const workspacesLbl = useMsg(messages.workspaces)
	const boardsLbl = useMsg(messages.boards)
	const newWorkspaceLbl = useMsg(messages.newWorkspace)
	const newBoardLbl = useMsg(messages.newBoard)
	const workspaceNamePlaceholderLbl = useMsg(messages.workspaceNamePlaceholder)
	const boardNamePlaceholderLbl = useMsg(messages.boardNamePlaceholder)
	const inviteWorkspaceLbl = useMsg(messages.inviteToWorkspace)
	const inviteBoardLbl = useMsg(messages.inviteToBoard)

	const workspaces = useUnoWorkspaces()
	const isAdmin = useIsUnoAdmin()
	const { board: currentBoard, workspace: currentWorkspace } = useUnoCurrentBoard()
	const boardsInWorkspace = currentWorkspace?.boards ?? []

	const updatePosition = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect()
		if (!rect) return
		setPosition({ top: rect.bottom + 6, left: rect.left })
	}, [])

	useEffect(() => {
		if (!isOpen) return
		updatePosition()

		const handlePointerDown = (e: PointerEvent) => {
			const target = e.target as Node
			if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return
			setIsOpen(false)
		}
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setIsOpen(false)
		}
		window.addEventListener('resize', updatePosition)
		document.addEventListener('pointerdown', handlePointerDown)
		document.addEventListener('keydown', handleKeyDown)
		return () => {
			window.removeEventListener('resize', updatePosition)
			document.removeEventListener('pointerdown', handlePointerDown)
			document.removeEventListener('keydown', handleKeyDown)
		}
	}, [isOpen, updatePosition])

	if (!currentBoard || !currentWorkspace) return null

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.toggle}
				data-testid="tla-workspace-switcher-toggle"
				aria-pressed={isOpen}
				aria-label={toggleLbl}
				title={toggleLbl}
				onClick={() => setIsOpen((v) => !v)}
			>
				<span className={styles.toggleLabel}>
					{intl.formatMessage(messages.breadcrumb, {
						workspace: currentWorkspace.name,
						board: currentBoard.name,
					})}
				</span>
			</button>
			{isOpen &&
				position &&
				createPortal(
					<div
						ref={panelRef}
						className={styles.panel}
						data-testid="tla-workspace-switcher-panel"
						style={{ top: position.top, left: position.left }}
					>
						<Section
							title={workspacesLbl}
							testIdPrefix="tla-workspace"
							canEdit={isAdmin}
							items={workspaces.map((w) => ({
								id: w.id,
								label: w.name,
								isCurrent: w.id === currentWorkspace.id,
								// Deleting the workspace you are standing in is fine — the directory
								// picks the next board — but there has to be one left to move to.
								canDelete: workspaces.length > 1,
								deleteConfirm: intl.formatMessage(messages.deleteWorkspaceConfirm, {
									name: w.name,
								}),
							}))}
							onSelect={(id) => {
								const target = workspaces.find((w) => w.id === id)
								if (target?.boards[0]) setCurrentBoardId(target.boards[0].id)
								setIsOpen(false)
							}}
							onCreate={(name) => {
								createUnoWorkspace(name)
								setIsOpen(false)
							}}
							onRename={renameUnoWorkspace}
							onDelete={deleteUnoWorkspace}
							addLabel={newWorkspaceLbl}
							namePlaceholder={workspaceNamePlaceholderLbl}
						/>
						{isAdmin && (
							<InviteRow
								scope="workspace"
								scopeId={currentWorkspace.id}
								label={inviteWorkspaceLbl}
							/>
						)}
						<Section
							title={boardsLbl}
							testIdPrefix="tla-board"
							canEdit={isAdmin}
							items={boardsInWorkspace.map((b) => ({
								id: b.id,
								label: b.name,
								isCurrent: b.id === currentBoard.id,
								canDelete: boardsInWorkspace.length > 1 || workspaces.length > 1,
								deleteConfirm: intl.formatMessage(messages.deleteBoardConfirm, { name: b.name }),
							}))}
							onSelect={(id) => {
								setCurrentBoardId(id)
								setIsOpen(false)
							}}
							onCreate={(name) => {
								createUnoBoard(currentWorkspace.id, name)
								setIsOpen(false)
							}}
							onRename={renameUnoBoard}
							onDelete={deleteUnoBoard}
							addLabel={newBoardLbl}
							namePlaceholder={boardNamePlaceholderLbl}
						/>
						{isAdmin && (
							<InviteRow scope="board" scopeId={currentBoard.id} label={inviteBoardLbl} />
						)}
					</div>,
					container
				)}
		</>
	)
}

interface SectionItem {
	id: string
	label: string
	isCurrent: boolean
	canDelete: boolean
	deleteConfirm: string
}

function Section({
	title,
	items,
	onSelect,
	onCreate,
	onRename,
	onDelete,
	addLabel,
	namePlaceholder,
	testIdPrefix,
	canEdit,
}: {
	title: string
	items: SectionItem[]
	onSelect(id: string): void
	onCreate(name: string): void
	onRename(id: string, name: string): void
	onDelete(id: string): void
	addLabel: string
	namePlaceholder: string
	testIdPrefix: string
	/** Only the admin creates, renames and deletes; everyone else gets a list they can switch with. */
	canEdit: boolean
}) {
	const [isCreating, setIsCreating] = useState(false)
	const [name, setName] = useState('')
	// At most one row is ever in a non-default state, so these are ids rather than per-row state.
	const [renamingId, setRenamingId] = useState<string | null>(null)
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const createLbl = useMsg(messages.create)
	const cancelLbl = useMsg(messages.cancel)
	const renameLbl = useMsg(messages.rename)
	const deleteLbl = useMsg(messages.delete)
	const saveLbl = useMsg(messages.save)

	useEffect(() => {
		if (isCreating) inputRef.current?.focus()
	}, [isCreating])

	const commit = () => {
		const trimmed = name.trim()
		if (!trimmed) return
		onCreate(trimmed)
		setName('')
		setIsCreating(false)
	}

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault()
		commit()
	}

	return (
		<div className={styles.section}>
			<div className={styles.sectionTitle}>{title}</div>
			{items.map((item) => {
				if (renamingId === item.id) {
					return (
						<NameForm
							key={item.id}
							initialValue={item.label}
							placeholder={namePlaceholder}
							confirmLabel={saveLbl}
							cancelLabel={cancelLbl}
							onConfirm={(value) => {
								onRename(item.id, value)
								setRenamingId(null)
							}}
							onCancel={() => setRenamingId(null)}
						/>
					)
				}

				if (confirmingDeleteId === item.id) {
					return (
						<div key={item.id} className={styles.confirm}>
							<div className={styles.confirmText}>{item.deleteConfirm}</div>
							<div className={styles.createActions}>
								<button
									type="button"
									className={styles.confirmDelete}
									data-testid={`${testIdPrefix}-delete-confirm`}
									onClick={() => {
										setConfirmingDeleteId(null)
										onDelete(item.id)
									}}
								>
									{deleteLbl}
								</button>
								<button
									type="button"
									className={styles.createCancel}
									onClick={() => setConfirmingDeleteId(null)}
								>
									{cancelLbl}
								</button>
							</div>
						</div>
					)
				}

				return (
					<div key={item.id} className={styles.row} data-current={item.isCurrent}>
						<button
							type="button"
							className={styles.rowSelect}
							aria-pressed={item.isCurrent}
							onClick={() => onSelect(item.id)}
						>
							<span className={styles.rowLabel}>{item.label}</span>
						</button>
						{canEdit && (
							<button
								type="button"
								className={styles.rowAction}
								aria-label={`${renameLbl}: ${item.label}`}
								title={renameLbl}
								data-testid={`${testIdPrefix}-rename`}
								onClick={() => {
									setConfirmingDeleteId(null)
									setRenamingId(item.id)
								}}
							>
								<TldrawUiIcon icon="edit" label={renameLbl} small />
							</button>
						)}
						{canEdit && item.canDelete && (
							<button
								type="button"
								className={styles.rowAction}
								aria-label={`${deleteLbl}: ${item.label}`}
								title={deleteLbl}
								data-testid={`${testIdPrefix}-delete`}
								onClick={() => {
									setRenamingId(null)
									setConfirmingDeleteId(item.id)
								}}
							>
								<TldrawUiIcon icon="trash" label={deleteLbl} small />
							</button>
						)}
					</div>
				)
			})}
			{!canEdit ? null : isCreating ? (
				<form className={styles.createForm} onSubmit={handleSubmit}>
					<input
						ref={inputRef}
						className={styles.createInput}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={namePlaceholder}
						onKeyDown={(e) => {
							// Stop tldraw's own shortcut handling (and anything else on the canvas)
							// from reacting to keystrokes meant for this field.
							e.stopPropagation()
							if (e.key === 'Escape') {
								setIsCreating(false)
								setName('')
							} else if (e.key === 'Enter') {
								e.preventDefault()
								commit()
							}
						}}
					/>
					<div className={styles.createActions}>
						<button type="submit" className={styles.createConfirm}>
							{createLbl}
						</button>
						<button
							type="button"
							className={styles.createCancel}
							onClick={() => {
								setIsCreating(false)
								setName('')
							}}
						>
							{cancelLbl}
						</button>
					</div>
				</form>
			) : (
				<button type="button" className={styles.addRow} onClick={() => setIsCreating(true)}>
					{addLabel}
				</button>
			)}
		</div>
	)
}

function NameForm({
	initialValue,
	placeholder,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
}: {
	initialValue: string
	placeholder: string
	confirmLabel: string
	cancelLabel: string
	onConfirm(value: string): void
	onCancel(): void
}) {
	const [value, setValue] = useState(initialValue)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [])

	const commit = () => {
		const trimmed = value.trim()
		if (!trimmed) return
		onConfirm(trimmed)
	}

	return (
		<form
			className={styles.createForm}
			onSubmit={(e) => {
				e.preventDefault()
				commit()
			}}
		>
			<input
				ref={inputRef}
				className={styles.createInput}
				value={value}
				placeholder={placeholder}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Escape') onCancel()
				}}
			/>
			<div className={styles.createActions}>
				<button type="submit" className={styles.createConfirm}>
					{confirmLabel}
				</button>
				<button type="button" className={styles.createCancel} onClick={onCancel}>
					{cancelLabel}
				</button>
			</div>
		</form>
	)
}

/**
 * Mints a link that lets someone into this workspace or this board, and copies it.
 *
 * A new token each time rather than a stable one per target: a link that has spread further than
 * intended can then be revoked from the admin panel without invalidating the one everyone else
 * already has. Admin only — an invite is the only way anyone gets in, so it is the one thing an
 * ordinary member must not be able to hand out.
 */
function InviteRow({
	scope,
	scopeId,
	label,
}: {
	scope: UnoInviteScope
	scopeId: string
	label: string
}) {
	const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
	const copiedLbl = useMsg(messages.copiedLink)
	const failedLbl = useMsg(messages.inviteFailed)

	useEffect(() => {
		if (state === 'idle') return
		const timeout = window.setTimeout(() => setState('idle'), 2000)
		return () => window.clearTimeout(timeout)
	}, [state])

	return (
		<div className={styles.section}>
			<button
				type="button"
				className={styles.linkRow}
				data-testid={`tla-invite-${scope}`}
				onClick={async () => {
					const url = await createUnoInviteUrl(scope, scopeId)
					if (!url) {
						setState('failed')
						return
					}
					try {
						await navigator.clipboard.writeText(url)
						setState('copied')
					} catch {
						// Clipboard access can be refused. The link exists either way, so show it
						// rather than losing it silently.
						window.prompt(label, url)
						setState('idle')
					}
				}}
			>
				{state === 'copied' ? copiedLbl : state === 'failed' ? failedLbl : label}
			</button>
		</div>
	)
}
