import { useParams } from 'react-router-dom'
import { TlaConnectionHandles } from '../../TlaConnect/TlaConnectionHandles'
import { TlaMediaOverlay } from '../../TlaMedia/TlaMediaOverlay'

/**
 * The media player is always mounted; the connection handles (drag-to-connect dots on a selected
 * shape) are only for the no-auth scratch canvas — same fileSlug gate as TlaEditorTopPanel.
 */
export function TlaEditorInFrontOfTheCanvas() {
	const fileSlug = useParams<{ fileSlug: string }>().fileSlug

	return (
		<>
			<TlaMediaOverlay />
			{!fileSlug && <TlaConnectionHandles />}
		</>
	)
}
