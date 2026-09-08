import { FormEvent, useState } from 'react'
import { useLocalStorageState } from 'tldraw'
import { defineMessages, useMsg } from '../../utils/i18n'
import styles from './identityGate.module.css'

export interface TlaLocalIdentity {
	name: string
	email: string
}

const IDENTITY_STORAGE_KEY = 'tldraw-dotcom:local-identity'

/**
 * The signed-out app has no account system, so this is the only place a name/email is captured —
 * for attributing local work, not for authenticating anything.
 */
export function useLocalIdentity() {
	return useLocalStorageState<TlaLocalIdentity | null>(IDENTITY_STORAGE_KEY, null)
}

const messages = defineMessages({
	title: { defaultMessage: 'Before you start' },
	description: { defaultMessage: 'Enter your name and email so your work is attributed to you.' },
	nameLabel: { defaultMessage: 'Display name' },
	namePlaceholder: { defaultMessage: 'Jane Doe' },
	emailLabel: { defaultMessage: 'Email' },
	emailPlaceholder: { defaultMessage: 'jane@example.com' },
	submit: { defaultMessage: 'Continue' },
})

export function TlaIdentityGate({ onDone }: { onDone(identity: TlaLocalIdentity): void }) {
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const title = useMsg(messages.title)
	const description = useMsg(messages.description)
	const nameLabel = useMsg(messages.nameLabel)
	const namePlaceholder = useMsg(messages.namePlaceholder)
	const emailLabel = useMsg(messages.emailLabel)
	const emailPlaceholder = useMsg(messages.emailPlaceholder)
	const submitLabel = useMsg(messages.submit)

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault()
		const trimmedName = name.trim()
		const trimmedEmail = email.trim()
		if (!trimmedName || !trimmedEmail) return
		onDone({ name: trimmedName, email: trimmedEmail })
	}

	return (
		<div className={styles.gate}>
			<form className={styles.card} onSubmit={handleSubmit}>
				<h1 className={styles.title}>{title}</h1>
				<p className={styles.description}>{description}</p>
				<label className={styles.field}>
					<span>{nameLabel}</span>
					<input
						type="text"
						required
						autoFocus
						value={name}
						placeholder={namePlaceholder}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className={styles.field}>
					<span>{emailLabel}</span>
					<input
						type="email"
						required
						value={email}
						placeholder={emailPlaceholder}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</label>
				<button type="submit" className={styles.submit}>
					{submitLabel}
				</button>
			</form>
		</div>
	)
}
