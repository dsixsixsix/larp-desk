import classNames from 'classnames'
import { TldrawUiIcon } from 'tldraw'
import { defineMessages, useMsg } from '../../../utils/i18n'
import { ExternalLink } from '../../ExternalLink/ExternalLink'
import styles from '../sidebar.module.css'

const messages = defineMessages({
	buildWithTldraw: { defaultMessage: 'Built on the tldraw SDK' },
})

export function TlaSidebarDotDevLink() {
	const lbl = useMsg(messages.buildWithTldraw)
	return (
		<ExternalLink
			className={classNames(styles.sidebarLinkButton, styles.hoverable, 'tla-text_ui__regular')}
			to="https://tldraw.dev"
			data-testid="tla-sidebar-dotdev-link"
			eventName="sidebar-dotdev-link-clicked"
		>
			<TldrawUiIcon icon="code" label={lbl} small />
			<span className={styles.sidebarLinkButtonLabel}>{lbl}</span>
		</ExternalLink>
	)
}
