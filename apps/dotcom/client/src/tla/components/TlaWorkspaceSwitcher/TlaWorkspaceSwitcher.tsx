import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TldrawUiIcon, useContainer, useValue } from 'tldraw'
import { defineMessages, useIntl, useMsg } from '../../utils/i18n'
import {
	canDeleteBoard,
	canDeleteWorkspace,
	createBoard,
	createWorkspace,
	deleteBoard,
	deleteWorkspace,
	getBoardInviteUrl,
	getBoardsForWorkspace,
	getLocalBoardsState,
	renameBoard,
	renameWorkspace,
	switchBoard,
	switchWorkspace,
} from '../../utils/localBoards'
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
	copyLink: { defaultMessage: 'Copy link to this board' },
	copiedLink: { defaultMessage: 'Link copied' },
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
 * TlaEditorTopPanel). Opens a panel to switch between existing workspaces/boards, rename them,
 * delete them, or create new ones — workspaces and boards are independent local documents; a
 * workspace is just the group a board belongs to, not a container with any other effect on it.
 * Local scratch canvas only.
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

	const boardsState = useValue('local-boards-state', () => getLocalBoardsState().get(), [])
	const currentBoard = boardsState.boards.find((b) => b.id === boardsState.currentBoardId)
	const currentWorkspace = currentBoard
		? boardsState.workspaces.find((w) => w.id === currentBoard.workspaceId)
		: undefined
	const boardsInWorkspace = currentWorkspace ? getBoardsForWorkspace(currentWorkspace.id) : []

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
							items={boardsState.workspaces.map((w) => ({
								id: w.id,
								label: w.name,
								isCurrent: w.id === currentWorkspace.id,
								canDelete: canDeleteWorkspace(w.id),
								deleteConfirm: intl.formatMessage(messages.deleteWorkspaceConfirm, {
									name: w.name,
								}),
							}))}
							onSelect={(id) => {
								switchWorkspace(id)
								setIsOpen(false)
							}}
							onCreate={(name) => {
								createWorkspace(name)
								setIsOpen(false)
							}}
							onRename={renameWorkspace}
							onDelete={deleteWorkspace}
							addLabel={newWorkspaceLbl}
							namePlaceholder={workspaceNamePlaceholderLbl}
						/>
						<CopyBoardLinkRow />
						<Section
							title={boardsLbl}
							testIdPrefix="tla-board"
							items={boardsInWorkspace.map((b) => ({
								id: b.id,
								label: b.name,
								isCurrent: b.id === currentBoard.id,
								canDelete: canDeleteBoard(b.id),
								deleteConfirm: intl.formatMessage(messages.deleteBoardConfirm, { name: b.name }),
							}))}
							onSelect={(id) => {
								switchBoard(id)
								setIsOpen(false)
							}}
							onCreate={(name) => {
								createBoard(name, currentWorkspace.id)
								setIsOpen(false)
							}}
							onRename={renameBoard}
							onDelete={deleteBoard}
							addLabel={newBoardLbl}
							namePlaceholder={boardNamePlaceholderLbl}
						/>
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
						{item.canDelete && (
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
			{isCreating ? (
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
 * Shares the board the user is on. What the link carries is the board's id, which is what the
 * live session is keyed on — so whoever opens it lands in the same room for presence and voice.
 * Their canvas starts empty: boards are local-first, and only the session is shared.
 */
function CopyBoardLinkRow() {
	const [isCopied, setIsCopied] = useState(false)
	const copyLbl = useMsg(messages.copyLink)
	const copiedLbl = useMsg(messages.copiedLink)

	useEffect(() => {
		if (!isCopied) return
		const timeout = window.setTimeout(() => setIsCopied(false), 2000)
		return () => window.clearTimeout(timeout)
	}, [isCopied])

	return (
		<div className={styles.section}>
			<button
				type="button"
				className={styles.linkRow}
				data-testid="tla-board-copy-link"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(getBoardInviteUrl())
						setIsCopied(true)
					} catch {
						// Clipboard access can be refused; the row simply doesn't confirm.
					}
				}}
			>
				{isCopied ? copiedLbl : copyLbl}
			</button>
		</div>
	)
}
