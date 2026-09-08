import { useCallback, useEffect, useRef, useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiButtonLabel,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogFooter,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiInput,
	useValue,
} from 'tldraw'
import { useApp } from '../../hooks/useAppState'
import { useTldrawAppUiEvents } from '../../utils/app-ui-events'
import { defineMessages, F, useMsg } from '../../utils/i18n'
import styles from './dialogs.module.css'

/** Long enough for a real name, short enough to stay readable on a collaborator's cursor. */
const MAX_DISPLAY_NAME_LENGTH = 40

const messages = defineMessages({
	displayName: { defaultMessage: 'Display name' },
	email: { defaultMessage: 'Email' },
	namePlaceholder: { defaultMessage: 'Your name' },
})

/**
 * The account panel: the name collaborators see on the canvas, and the address the account
 * is signed in with.
 *
 * The name is committed on save rather than per keystroke — it is broadcast to everyone in the
 * room, and half-typed names should not be.
 */
export function TlaAccountDialog({ onClose }: { onClose(): void }) {
	const app = useApp()
	const trackEvent = useTldrawAppUiEvents()
	const namePlaceholder = useMsg(messages.namePlaceholder)
	const displayNameLbl = useMsg(messages.displayName)
	const emailLbl = useMsg(messages.email)

	const user = useValue('user', () => app.getUser(), [app])
	const [name, setName] = useState(user?.name ?? '')
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		// Opened from a dropdown item, whose close restores focus to its trigger; wait for that.
		const timeout = window.setTimeout(() => {
			inputRef.current?.focus()
			inputRef.current?.select()
		}, 0)
		return () => window.clearTimeout(timeout)
	}, [])

	const handleSave = useCallback(() => {
		const trimmed = name.trim()
		// An empty name would leave the user as an anonymous cursor with no way back from here.
		if (trimmed && trimmed !== user?.name) {
			app.updateUser({ name: trimmed })
			trackEvent('change-user-name', { source: 'account-menu' })
		}
		onClose()
	}, [app, name, onClose, trackEvent, user?.name])

	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>
					<F defaultMessage="Account" />
				</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ maxWidth: 350, paddingTop: 0 }}>
				<div className={styles.section}>
					<div className={styles.dialogFieldLabelRow}>
						<F defaultMessage="Display name" />
					</div>
					<TldrawUiInput
						aria-label={displayNameLbl}
						ref={inputRef}
						className={styles.dialogInput}
						data-testid="tla-account-name-input"
						value={name}
						onValueChange={setName}
						onComplete={handleSave}
						onCancel={onClose}
						placeholder={namePlaceholder}
						maxLength={MAX_DISPLAY_NAME_LENGTH}
					/>
					<p className={styles.dialogFieldHelp}>
						<F defaultMessage="This is the name shown on your cursor to everyone on the board." />
					</p>
				</div>
				<div className={styles.section}>
					<div className={styles.dialogFieldLabelRow}>
						<F defaultMessage="Email" />
					</div>
					<input
						aria-label={emailLbl}
						className={styles.dialogInput}
						data-testid="tla-account-email"
						value={user?.email ?? ''}
						readOnly
						disabled
					/>
					<p className={styles.dialogFieldHelp}>
						<F defaultMessage="The address you signed in with. Change it from your sign-in provider." />
					</p>
				</div>
			</TldrawUiDialogBody>
			<TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<TldrawUiButton type="normal" onClick={onClose}>
					<TldrawUiButtonLabel>
						<F defaultMessage="Cancel" />
					</TldrawUiButtonLabel>
				</TldrawUiButton>
				<TldrawUiButton type="primary" onClick={handleSave} data-testid="tla-account-save">
					<TldrawUiButtonLabel>
						<F defaultMessage="Save" />
					</TldrawUiButtonLabel>
				</TldrawUiButton>
			</TldrawUiDialogFooter>
		</>
	)
}
