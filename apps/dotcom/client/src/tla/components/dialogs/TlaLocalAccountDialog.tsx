import classNames from 'classnames'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiButtonLabel,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogFooter,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiInput,
	useDialogs,
	useEditor,
} from 'tldraw'
import { useUnoUser } from '../../hooks/useUnoDirectory'
import { useTldrawAppUiEvents } from '../../utils/app-ui-events'
import { defineMessages, F, useMsg } from '../../utils/i18n'
import { resetUnoLocalData, updateUnoOwnName } from '../../utils/unoDirectory'
import { TlaAudioDeviceSettings, TlaVoiceChatSettings } from '../TlaAudioSettings/TlaAudioSettings'
import { TlaManageCookiesDialog } from './TlaManageCookiesDialog'
import styles from './dialogs.module.css'

/** Long enough for a real name, short enough to stay readable on a collaborator's cursor. */
const MAX_DISPLAY_NAME_LENGTH = 40

type SettingsSection = 'profile' | 'audio' | 'voice' | 'data'

const messages = defineMessages({
	title: { defaultMessage: 'Settings' },
	profile: { defaultMessage: 'Profile' },
	audio: { defaultMessage: 'Audio' },
	voice: { defaultMessage: 'Voice chat' },
	data: { defaultMessage: 'Local data' },
	displayName: { defaultMessage: 'Display name' },
	displayNameHelp: { defaultMessage: 'Shown next to your cursor when you work with other people.' },
	email: { defaultMessage: 'Email' },
	emailHelp: {
		defaultMessage:
			'The address you joined with. It is what a second invite is matched on, so it cannot be changed here.',
	},
	namePlaceholder: { defaultMessage: 'Your name' },
	emailPlaceholder: { defaultMessage: 'you@example.com' },
	resetSession: { defaultMessage: 'Sign out and delete local data' },
	resetSessionHelp: {
		defaultMessage:
			'Board contents live in this browser and stay until you clear them. This signs you out and deletes every board you have here. Your invites are unaffected — the same link signs you back in.',
	},
	resetSessionConfirm: { defaultMessage: 'Sign out and delete every board on this machine?' },
	cancel: { defaultMessage: 'Cancel' },
	manageCookies: { defaultMessage: 'Manage cookies' },
	manageCookiesHelp: {
		defaultMessage: 'Change or withdraw the analytics cookie choice you made on your first visit.',
	},
})

/**
 * The local equivalent of TlaAccountDialog. The name and email come from the invite this browser
 * redeemed (see unoDirectory.ts) rather than from a signed-in account: the name is editable, the
 * email is the identity two invites are matched on and is not.
 *
 * Laid out as sections down the side rather than one long column — audio devices, voice chat
 * behaviour and "delete everything" have nothing to do with each other, and a single scroll put
 * the destructive one directly under a volume slider.
 */
export function TlaLocalAccountDialog({ onClose }: { onClose(): void }) {
	const editor = useEditor()
	const trackEvent = useTldrawAppUiEvents()
	const titleLbl = useMsg(messages.title)
	const profileLbl = useMsg(messages.profile)
	const audioLbl = useMsg(messages.audio)
	const voiceLbl = useMsg(messages.voice)
	const dataLbl = useMsg(messages.data)

	const [section, setSection] = useState<SettingsSection>('profile')
	const user = useUnoUser()
	const [name, setName] = useState(user?.name ?? '')

	// The directory resolves a moment after the first render, so the field is seeded from it when
	// it arrives rather than from the empty default it had at mount.
	useEffect(() => {
		if (user) setName(user.name)
	}, [user])

	const handleSave = useCallback(() => {
		const trimmedName = name.trim()
		// An empty name would leave this person nameless on every cursor, so it is simply not saved.
		if (!trimmedName || !user || trimmedName === user.name) {
			onClose()
			return
		}
		updateUnoOwnName(trimmedName)
		editor.user.updateUserPreferences({ name: trimmedName })
		trackEvent('change-user-name', { source: 'account-menu' })
		onClose()
	}, [editor, name, user, onClose, trackEvent])

	const sections: { id: SettingsSection; label: string }[] = [
		{ id: 'profile', label: profileLbl },
		{ id: 'audio', label: audioLbl },
		{ id: 'voice', label: voiceLbl },
		{ id: 'data', label: dataLbl },
	]

	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>{titleLbl}</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody className={styles.settingsBody}>
				<nav className={styles.settingsNav} aria-label={titleLbl}>
					{sections.map((item) => (
						<button
							key={item.id}
							type="button"
							className={styles.settingsNavItem}
							aria-current={section === item.id}
							data-testid={`tla-settings-tab-${item.id}`}
							onClick={() => setSection(item.id)}
						>
							{item.label}
						</button>
					))}
				</nav>

				<div className={styles.settingsPanel} data-testid={`tla-settings-panel-${section}`}>
					{section === 'profile' && (
						<ProfileSection
							name={name}
							email={user?.email ?? ''}
							onNameChange={setName}
							onComplete={handleSave}
							onCancel={onClose}
						/>
					)}
					{section === 'audio' && (
						<SettingsGroup title={audioLbl}>
							<TlaAudioDeviceSettings />
						</SettingsGroup>
					)}
					{section === 'voice' && (
						<SettingsGroup title={voiceLbl}>
							<TlaVoiceChatSettings />
						</SettingsGroup>
					)}
					{section === 'data' && (
						<SettingsGroup title={dataLbl}>
							<CookieSettingsSection />
							<ResetLocalDataSection />
						</SettingsGroup>
					)}
				</div>
			</TldrawUiDialogBody>
			<TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<TldrawUiButton type="normal" onClick={onClose}>
					<TldrawUiButtonLabel>
						<F defaultMessage="Cancel" />
					</TldrawUiButtonLabel>
				</TldrawUiButton>
				<TldrawUiButton type="primary" onClick={handleSave} data-testid="tla-local-account-save">
					<TldrawUiButtonLabel>
						<F defaultMessage="Save" />
					</TldrawUiButtonLabel>
				</TldrawUiButton>
			</TldrawUiDialogFooter>
		</>
	)
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
	return (
		<>
			<h2 className={styles.settingsHeading}>{title}</h2>
			{children}
		</>
	)
}

function ProfileSection({
	name,
	email,
	onNameChange,
	onComplete,
	onCancel,
}: {
	name: string
	email: string
	onNameChange(value: string): void
	onComplete(): void
	onCancel(): void
}) {
	const namePlaceholder = useMsg(messages.namePlaceholder)
	const emailPlaceholder = useMsg(messages.emailPlaceholder)
	const displayNameLbl = useMsg(messages.displayName)
	const displayNameHelp = useMsg(messages.displayNameHelp)
	const emailLbl = useMsg(messages.email)
	const emailHelp = useMsg(messages.emailHelp)
	const profileLbl = useMsg(messages.profile)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		// Opened from a toolbar button, whose close restores focus to its trigger; wait for that.
		const timeout = window.setTimeout(() => {
			inputRef.current?.focus()
			inputRef.current?.select()
		}, 0)
		return () => window.clearTimeout(timeout)
	}, [])

	return (
		<>
			<h2 className={styles.settingsHeading}>{profileLbl}</h2>
			<div className={styles.section}>
				<div className={styles.dialogFieldLabelRow}>{displayNameLbl}</div>
				<TldrawUiInput
					aria-label={displayNameLbl}
					ref={inputRef}
					className={styles.dialogInput}
					data-testid="tla-local-account-name-input"
					value={name}
					onValueChange={onNameChange}
					onComplete={onComplete}
					onCancel={onCancel}
					placeholder={namePlaceholder}
					maxLength={MAX_DISPLAY_NAME_LENGTH}
				/>
				<div className={styles.sectionHelp}>{displayNameHelp}</div>
			</div>
			<div className={styles.section}>
				<div className={styles.dialogFieldLabelRow}>{emailLbl}</div>
				<input
					aria-label={emailLbl}
					type="email"
					readOnly
					className={styles.dialogInput}
					data-testid="tla-local-account-email"
					value={email}
					placeholder={emailPlaceholder}
				/>
				<div className={styles.sectionHelp}>{emailHelp}</div>
			</div>
		</>
	)
}

/**
 * Signing out, which on a local-first app also means deleting the documents: the boards are on
 * this disk, and leaving them behind on a shared machine is the thing signing out is for. Reloading
 * afterwards is what puts the invite wall back up (see TlaIdentityGate).
 */
function ResetLocalDataSection() {
	const [isConfirming, setIsConfirming] = useState(false)
	const user = useUnoUser()
	const resetLbl = useMsg(messages.resetSession)
	const helpLbl = useMsg(messages.resetSessionHelp)
	const confirmLbl = useMsg(messages.resetSessionConfirm)
	const cancelLbl = useMsg(messages.cancel)

	const handleReset = useCallback(async () => {
		await resetUnoLocalData()
		window.location.reload()
	}, [])

	// Nothing to sign out of until the directory has resolved.
	if (!user) return null

	return (
		<div className={styles.section}>
			<div className={styles.sectionHelp}>{helpLbl}</div>
			{isConfirming ? (
				<>
					<div className={styles.sectionHelp}>{confirmLbl}</div>
					<div className={styles.settingsActionRow}>
						<button
							type="button"
							className={classNames(styles.inlineButton, styles.inlineButtonDanger)}
							data-testid="tla-local-reset-confirm"
							onClick={handleReset}
						>
							{resetLbl}
						</button>
						<button
							type="button"
							className={styles.inlineButton}
							onClick={() => setIsConfirming(false)}
						>
							{cancelLbl}
						</button>
					</div>
				</>
			) : (
				<button
					type="button"
					className={classNames(styles.inlineButton, styles.inlineButtonDanger)}
					data-testid="tla-local-reset"
					onClick={() => setIsConfirming(true)}
				>
					{resetLbl}
				</button>
			)}
		</div>
	)
}

/**
 * Cookie settings live here rather than in the page menu, but they do have to live somewhere:
 * withdrawing consent has to be as easy as giving it, and the consent banner is the only other
 * place that asks.
 */
function CookieSettingsSection() {
	const { addDialog } = useDialogs()
	const manageCookiesLbl = useMsg(messages.manageCookies)
	const helpLbl = useMsg(messages.manageCookiesHelp)

	return (
		<div className={styles.section}>
			<div className={styles.sectionHelp}>{helpLbl}</div>
			<button
				type="button"
				className={styles.inlineButton}
				data-testid="tla-settings-manage-cookies"
				onClick={() => addDialog({ component: () => <TlaManageCookiesDialog /> })}
			>
				{manageCookiesLbl}
			</button>
		</div>
	)
}
