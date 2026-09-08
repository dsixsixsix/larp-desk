import { useParams } from 'react-router-dom'
import { TlaActivityLogTracker } from '../../TlaActivityLog/TlaActivityLogTracker'
import { TlaBoardSidebar } from '../../TlaBoardSidebar/TlaBoardSidebar'
import { TlaHeaderBackground } from '../../TlaHeader/TlaHeaderBackground'
import { TlaHeaderSearch } from '../../TlaHeader/TlaHeaderSearch'
import { TlaWorkspaceSwitcher } from '../../TlaWorkspaceSwitcher/TlaWorkspaceSwitcher'

/**
 * Empty for the file editor — only the no-auth scratch canvas gets the header search bar, board
 * outline sidebar and activity log (none of these are part of the signed-in file/dashboard flow
 * yet).
 */
export function TlaEditorTopPanel() {
	const fileSlug = useParams<{ fileSlug: string }>().fileSlug
	if (fileSlug) return null

	return (
		<>
			<TlaHeaderBackground />
			<TlaBoardSidebar />
			<TlaWorkspaceSwitcher />
			<TlaHeaderSearch />
			<TlaActivityLogTracker />
		</>
	)
}
