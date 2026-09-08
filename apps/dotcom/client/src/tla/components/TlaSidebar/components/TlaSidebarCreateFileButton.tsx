import { TldrawUiButton } from 'tldraw'
import { useCreateFileInActiveWorkspace } from '../../../hooks/useWorkspaceNavigation'
import { useMsg } from '../../../utils/i18n'
import { TlaIcon } from '../../TlaIcon/TlaIcon'
import { messages } from './sidebar-shared'
import styles from '../sidebar.module.css'

export function TlaSidebarCreateFileButton() {
	const createTitle = useMsg(messages.create)
	const handleSidebarCreate = useCreateFileInActiveWorkspace('sidebar')

	return (
		<TldrawUiButton
			type="icon"
			className={styles.sidebarCreateFileButton}
			onClick={handleSidebarCreate}
			data-testid="tla-create-file"
			tooltip={createTitle}
			title={createTitle}
		>
			<TlaIcon icon="edit-strong" style={{ left: 1 }} />
		</TldrawUiButton>
	)
}
