import { PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from 'react'
import { Editor, TLShapeId, VecLike, createShapeId, track, useEditor } from 'tldraw'
import styles from './connect.module.css'

// Pushed out past the shape's own edge by OFFSET screen pixels (independent of zoom) — sitting
// right on the edge would land exactly on top of tldraw's native resize handles, which use the
// same four side-midpoints for single-axis resizing.
const OFFSET = 14

// How close the pointer has to get to another shape's side dot, in screen pixels, to snap to it.
const SNAP_RADIUS = 20

const SIDES = [
	{ name: 'top', anchor: { x: 0.5, y: 0 }, dx: 0, dy: -1 },
	{ name: 'right', anchor: { x: 1, y: 0.5 }, dx: 1, dy: 0 },
	{ name: 'bottom', anchor: { x: 0.5, y: 1 }, dx: 0, dy: 1 },
	{ name: 'left', anchor: { x: 0, y: 0.5 }, dx: -1, dy: 0 },
] as const

type Side = (typeof SIDES)[number]

interface SidePoint {
	side: Side
	/** Screen position of the rendered (offset) dot. */
	point: VecLike
}

interface DragState {
	sourceId: TLShapeId
	anchor: { x: number; y: number }
	start: VecLike
	current: VecLike
	targetId: TLShapeId | null
	snapped: SidePoint | null
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value))
}

function dist(a: VecLike, b: VecLike): number {
	return Math.hypot(a.x - b.x, a.y - b.y)
}

/** The four side-dot screen positions for a shape, offset past its edge the same way the
 *  rendered handles are — used both to draw them and to hit-test snapping against them. */
function getSidePoints(editor: Editor, shapeId: TLShapeId): SidePoint[] {
	const bounds = editor.getShapePageBounds(shapeId)
	if (!bounds) return []
	return SIDES.map((side) => {
		const base = editor.pageToViewport({
			x: bounds.minX + bounds.width * side.anchor.x,
			y: bounds.minY + bounds.height * side.anchor.y,
		})
		return { side, point: { x: base.x + side.dx * OFFSET, y: base.y + side.dy * OFFSET } }
	})
}

/** Creates an elbow arrow bound from the dragged side of `sourceId` to `targetId`, in one undo
 *  step. Both ends bind with `isPrecise: true` and `snap: 'edge-point'`, so the elbow router
 *  treats each anchor as a fixed exit/entry side and routes an orthogonal path between them
 *  instead of cutting straight through either shape. */
function connectShapes(
	editor: Editor,
	sourceId: TLShapeId,
	sourceAnchor: { x: number; y: number },
	targetId: TLShapeId,
	targetAnchor: { x: number; y: number }
) {
	const sourceBounds = editor.getShapePageBounds(sourceId)
	const targetBounds = editor.getShapePageBounds(targetId)
	if (!sourceBounds || !targetBounds) return

	editor.run(() => {
		editor.markHistoryStoppingPoint('connect shapes')
		const arrowId = createShapeId()
		editor.createShape({
			id: arrowId,
			type: 'arrow',
			x: sourceBounds.center.x,
			y: sourceBounds.center.y,
			props: { kind: 'elbow' },
		})
		editor.createBindings([
			{
				fromId: arrowId,
				toId: sourceId,
				type: 'arrow',
				props: {
					terminal: 'start',
					normalizedAnchor: sourceAnchor,
					isExact: false,
					isPrecise: true,
					snap: 'edge-point',
				},
			},
			{
				fromId: arrowId,
				toId: targetId,
				type: 'arrow',
				props: {
					terminal: 'end',
					normalizedAnchor: targetAnchor,
					isExact: false,
					isPrecise: true,
					snap: 'edge-point',
				},
			},
		])
	})
}

/**
 * Dots at the midpoint of each side of the selected shape (local scratch canvas only — see
 * TlaEditorInFrontOfTheCanvas). Dragging one to another shape creates a bound elbow arrow between
 * them, the same connection the arrow tool makes, but discoverable without knowing that tool
 * exists. While dragging, the shape under the pointer shows its own four dots too, and getting
 * close to one snaps the connection to that exact point — like Miro's connector handles.
 *
 * The drag is handled entirely outside the editor's own state machine — a native `setPointerCapture`
 * on the dot keeps every move/up event routed to it regardless of what's underneath the pointer —
 * so `select.idle` and the current selection never change mid-drag, and this component's own
 * visibility never needs to special-case "while dragging".
 */
export const TlaConnectionHandles = track(function TlaConnectionHandles() {
	const editor = useEditor()
	const [drag, setDrag] = useState<DragState | null>(null)
	const dragRef = useRef<DragState | null>(null)

	const shape = editor.getOnlySelectedShape()
	const bounds = shape ? editor.getShapePageBounds(shape.id) : undefined
	const showHandles =
		!!shape &&
		!!bounds &&
		bounds.width > 0 &&
		bounds.height > 0 &&
		!shape.isLocked &&
		!editor.isShapeOfType(shape, 'arrow') &&
		editor.isIn('select.idle')

	const handlePointerDown = useCallback(
		(
			e: ReactPointerEvent<HTMLDivElement>,
			sourceId: TLShapeId,
			anchor: { x: number; y: number }
		) => {
			e.stopPropagation()
			e.preventDefault()
			e.currentTarget.setPointerCapture(e.pointerId)
			const point = { x: e.clientX, y: e.clientY }
			const next: DragState = {
				sourceId,
				anchor,
				start: point,
				current: point,
				targetId: null,
				snapped: null,
			}
			dragRef.current = next
			setDrag(next)
		},
		[]
	)

	const handlePointerMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			const current = dragRef.current
			if (!current) return
			e.stopPropagation()
			const point = { x: e.clientX, y: e.clientY }
			const pagePoint = editor.screenToPage(point)
			const hit = editor.getShapeAtPoint(pagePoint, {
				hitInside: true,
				margin: SNAP_RADIUS,
				filter: (s) => s.id !== current.sourceId && s.type !== 'arrow' && !s.isLocked,
			})

			let snapped: SidePoint | null = null
			if (hit) {
				let nearest: SidePoint | null = null
				let nearestDist = SNAP_RADIUS
				for (const sidePoint of getSidePoints(editor, hit.id)) {
					const d = dist(sidePoint.point, point)
					if (d <= nearestDist) {
						nearest = sidePoint
						nearestDist = d
					}
				}
				snapped = nearest
			}

			const next: DragState = { ...current, current: point, targetId: hit?.id ?? null, snapped }
			dragRef.current = next
			setDrag(next)
		},
		[editor]
	)

	const handlePointerUp = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.stopPropagation()
			const current = dragRef.current
			dragRef.current = null
			setDrag(null)
			if (!current?.targetId) return

			if (current.snapped) {
				connectShapes(
					editor,
					current.sourceId,
					current.anchor,
					current.targetId,
					current.snapped.side.anchor
				)
				return
			}

			const targetBounds = editor.getShapePageBounds(current.targetId)
			let targetAnchor = { x: 0.5, y: 0.5 }
			if (targetBounds && targetBounds.width > 0 && targetBounds.height > 0) {
				const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY })
				targetAnchor = {
					x: clamp01((pagePoint.x - targetBounds.minX) / targetBounds.width),
					y: clamp01((pagePoint.y - targetBounds.minY) / targetBounds.height),
				}
			}
			connectShapes(editor, current.sourceId, current.anchor, current.targetId, targetAnchor)
		},
		[editor]
	)

	const targetSidePoints = drag?.targetId ? getSidePoints(editor, drag.targetId) : []

	return (
		<>
			{showHandles &&
				bounds &&
				SIDES.map((side) => {
					const point = editor.pageToViewport({
						x: bounds.minX + bounds.width * side.anchor.x,
						y: bounds.minY + bounds.height * side.anchor.y,
					})
					return (
						<div
							key={side.name}
							className={styles.handle}
							style={{
								transform: `translate(${point.x + side.dx * OFFSET}px, ${point.y + side.dy * OFFSET}px)`,
							}}
							onPointerDown={(e) => handlePointerDown(e, shape!.id, side.anchor)}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerUp}
						/>
					)
				})}
			{drag &&
				targetSidePoints.map(({ side, point }) => (
					<div
						key={side.name}
						className={
							drag.snapped?.side.name === side.name
								? `${styles.handle} ${styles.handleSnapped}`
								: styles.handle
						}
						style={{ transform: `translate(${point.x}px, ${point.y}px)`, pointerEvents: 'none' }}
					/>
				))}
			{drag && (
				<svg className={styles.dragOverlay}>
					<line
						x1={drag.start.x}
						y1={drag.start.y}
						x2={drag.snapped ? drag.snapped.point.x : drag.current.x}
						y2={drag.snapped ? drag.snapped.point.y : drag.current.y}
					/>
					{drag.targetId &&
						!drag.snapped &&
						(() => {
							const targetBounds = editor.getShapePageBounds(drag.targetId!)
							if (!targetBounds) return null
							const topLeft = editor.pageToViewport({ x: targetBounds.minX, y: targetBounds.minY })
							return (
								<rect
									className={styles.dragTarget}
									x={topLeft.x}
									y={topLeft.y}
									width={targetBounds.width * editor.getZoomLevel()}
									height={targetBounds.height * editor.getZoomLevel()}
								/>
							)
						})()}
				</svg>
			)}
		</>
	)
})
