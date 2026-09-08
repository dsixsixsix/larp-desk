import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TldrawUiIcon, useContainer, useEditor, useValue } from 'tldraw'
import { defineMessages, useMsg } from '../../utils/i18n'
import { getActivityLogEntries } from './activityLogState'
import styles from './activity-log.module.css'

const messages = defineMessages({
	toggle: { defaultMessage: 'Recent activity' },
	empty: { defaultMessage: 'Nothing has happened yet' },
})

function formatTime(time: number): string {
	return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The header icon that opens a dropdown of TlaActivityLogTracker's recorded entries.
 *
 * The dropdown is portaled rather than positioned relative to this button: the button sits inside
 * `.tlui-layout__top__right`, which clips overflow, so an absolutely positioned child would get
 * cut off instead of floating over the canvas. The portal target is the themed editor container,
 * not `<body>` — the panel's colours come from theme variables scoped to `.tla`/`.tl-theme__*`,
 * which don't resolve on `<body>`, leaving the panel fully transparent.
 */
export function TlaActivityLogButton() {
	const editor = useEditor()
	const [isOpen, setIsOpen] = useState(false)
	const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
	const buttonRef = useRef<HTMLButtonElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)
	const container = useContainer()
	const toggleLbl = useMsg(messages.toggle)
	const emptyLbl = useMsg(messages.empty)
	const entries = useValue('activity-log-entries', () => getActivityLogEntries().get(), [])
	// The style (color/shape) panel shares this corner of the screen and shows up whenever
	// something's selected — recompute the dropdown's position whenever that changes so it can
	// dodge the style panel instead of rendering on top of it.
	const hasSelection = useValue(
		'activity-log-has-selection',
		() => editor.getSelectedShapeIds().length > 0,
		[editor]
	)

	const updatePosition = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect()
		if (!rect) return
		const stylePanelRect = document
			.querySelector('.tlui-style-panel__wrapper')
			?.getBoundingClientRect()
		const right = stylePanelRect
			? window.innerWidth - stylePanelRect.left + 6
			: window.innerWidth - rect.right
		setPosition({ top: rect.bottom + 6, right })
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
	}, [isOpen, updatePosition, hasSelection])

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.toggle}
				data-testid="tla-activity-log-toggle"
				aria-pressed={isOpen}
				aria-label={toggleLbl}
				title={toggleLbl}
				onClick={() => setIsOpen((v) => !v)}
			>
				<TldrawUiIcon icon="list" label={toggleLbl} small />
			</button>
			{isOpen &&
				position &&
				createPortal(
					<div
						ref={panelRef}
						className={styles.panel}
						data-testid="tla-activity-log-panel"
						style={{ top: position.top, right: position.right }}
					>
						{entries.length === 0 ? (
							<div className={styles.empty}>{emptyLbl}</div>
						) : (
							entries.map((entry) => (
								<div key={entry.id} className={styles.entry}>
									<div className={styles.entryMain}>
										<span className={styles.entryMessage}>{entry.message}</span>
										<span className={styles.entryTime}>{formatTime(entry.time)}</span>
									</div>
									{entry.user && <span className={styles.entryUser}>{entry.user}</span>}
								</div>
							))
						)}
					</div>,
					container
				)}
		</>
	)
}
