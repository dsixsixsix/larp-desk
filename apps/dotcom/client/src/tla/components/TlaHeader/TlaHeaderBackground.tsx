import styles from './header.module.css'

/** The visual band that ties the left panel, search box and right panel into one header — see
 * header.module.css for why it's a separate fixed strip rather than a shared container. */
export function TlaHeaderBackground() {
	return <div className={styles.headerBackground} aria-hidden />
}
