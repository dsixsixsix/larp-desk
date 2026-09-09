import { useEffect } from 'react'
import { Editor, TLAsset, TLShape, useEditor } from 'tldraw'
import { useUnoUser } from '../../hooks/useUnoDirectory'
import { BOARD_FILE_ASSET_TYPE, TLBoardFileAsset } from '../TlaFile/FileAssetUtil'
import { FILE_CARD_TYPE } from '../TlaFile/FileCardShapeUtil'
import { pushActivityLogEntry } from './activityLogState'

function shapeTypeLabel(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1)
}

function describeShape(
	editor: Editor,
	shape: TLShape,
	addedAssets: Record<string, TLAsset>
): string {
	if (shape.type === 'frame') {
		return shape.props.name?.trim() || 'frame'
	}
	if (shape.type === FILE_CARD_TYPE) {
		const assetId = shape.props.assetId
		const asset = assetId
			? ((addedAssets[assetId] as TLBoardFileAsset | undefined) ??
				editor.getAsset<TLBoardFileAsset>(assetId))
			: undefined
		const name = asset?.props.name?.trim()
		return name ? `file "${name}"` : 'file'
	}
	return shapeTypeLabel(shape.type).toLowerCase()
}

/**
 * Mounted once for the local scratch canvas (see TlaEditorTopPanel). Listens to the store and
 * turns a useful subset of document changes into human-readable entries for TlaActivityLogButton:
 * shape add/delete, color changes, and file description add/remove/edit. Geometry churn (drag,
 * resize) is deliberately ignored — logging every intermediate update would spam the log on every
 * pointermove.
 */
export function TlaActivityLogTracker() {
	const editor = useEditor()
	const identity = useUnoUser()
	const user = identity?.name.trim() || null

	useEffect(() => {
		return editor.store.listen(
			({ changes }) => {
				const addedAssets: Record<string, TLAsset> = {}
				for (const record of Object.values(changes.added)) {
					if (record.typeName === 'asset') addedAssets[record.id] = record
				}

				for (const record of Object.values(changes.added)) {
					if (record.typeName !== 'shape') continue
					pushActivityLogEntry(`Added ${describeShape(editor, record, addedAssets)}`, user)
				}

				for (const [from, to] of Object.values(changes.updated)) {
					if (from.typeName === 'shape' && to.typeName === 'shape') {
						if ('color' in to.props) {
							const prevColor = (from.props as { color?: unknown }).color
							const nextColor = (to.props as { color?: unknown }).color
							if (prevColor !== nextColor) {
								pushActivityLogEntry(
									`Changed color of ${describeShape(editor, to, addedAssets)} to ${nextColor}`,
									user
								)
							}
						}
						continue
					}
					if (
						from.typeName === 'asset' &&
						to.typeName === 'asset' &&
						to.type === BOARD_FILE_ASSET_TYPE
					) {
						const fromDesc = (from as TLBoardFileAsset).props.description
						const toDesc = (to as TLBoardFileAsset).props.description
						if (fromDesc === toDesc) continue
						const label = to.props.name?.trim() ? `"${to.props.name.trim()}"` : 'file'
						if (!fromDesc && toDesc) pushActivityLogEntry(`Added description to ${label}`, user)
						else if (fromDesc && !toDesc)
							pushActivityLogEntry(`Removed description from ${label}`, user)
						else pushActivityLogEntry(`Edited description of ${label}`, user)
					}
				}

				for (const record of Object.values(changes.removed)) {
					if (record.typeName !== 'shape') continue
					pushActivityLogEntry(`Deleted ${describeShape(editor, record, {})}`, user)
				}
			},
			{ source: 'user', scope: 'document' }
		)
	}, [editor, user])

	return null
}
