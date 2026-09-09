import { UnoInviteInfo } from '@tldraw/dotcom-shared'
import { FormEvent, useEffect, useState } from 'react'
import { defineMessages, F, useMsg } from '../../utils/i18n'
import {
	UnoAdminLoginError,
	UnoJoinError,
	acceptUnoInvite,
	createUnoBoard,
	createUnoWorkspace,
	getUnoInviteInfo,
	getUnoSessionState,
	signInUnoAdmin,
} from '../../utils/unoDirectory'
import styles from './identityGate.module.css'

/**
 * The three ways into the app, and the wall in front of everything else.
 *
 * There is no sign-up: an invite link is the only way to become a user, and the admin is the only
 * one who can mint links (see UnoDirectoryDurableObject in the sync worker). A name and email are
 * asked for once, when a link is redeemed — the name is what appears next to your cursor, and the
 * email is what makes a second invite land on the same person rather than a second one.
 */

const messages = defineMessages({
	joinTitle: { defaultMessage: 'Join {target}' },
	joinDescription: {
		defaultMessage: 'Enter your name and email. Your name is what other people on the board see.',
	},
	nameLabel: { defaultMessage: 'Display name' },
	namePlaceholder: { defaultMessage: 'Jane Doe' },
	emailLabel: { defaultMessage: 'Email' },
	emailPlaceholder: { defaultMessage: 'jane@example.com' },
	join: { defaultMessage: 'Join' },
	joining: { defaultMessage: 'Joining…' },
	inviteInvalid: {
		defaultMessage: 'This invite link is no longer valid. Ask for a new one.',
	},
	inviteReserved: {
		defaultMessage:
			'That address belongs to the administrator, who signs in with a secret instead.',
	},
	inviteNetwork: { defaultMessage: 'Could not reach the server. Check your connection and retry.' },
	noAccessTitle: { defaultMessage: 'Invite only' },
	noAccessDescription: {
		defaultMessage:
			'To use UnoCode, ask for an invite link to a workspace or a board. The link is the only way in.',
	},
	adminTitle: { defaultMessage: 'Administrator sign-in' },
	adminDescription: {
		defaultMessage: 'Enter the deployment secret to manage workspaces, boards and people.',
	},
	adminSecretLabel: { defaultMessage: 'Secret' },
	adminSignIn: { defaultMessage: 'Sign in' },
	adminDenied: { defaultMessage: 'That secret is not right.' },
	adminLocked: {
		defaultMessage: 'Too many attempts. Sign-in is locked for a while.',
	},
	loading: { defaultMessage: 'Checking the link…' },
})

/** The wall an unauthenticated visitor lands on. It offers nothing, because there is nothing to offer. */
export function TlaNoAccessGate() {
	return (
		<div className={styles.gate}>
			<div className={styles.card}>
				<h1 className={styles.title}>
					<F {...messages.noAccessTitle} />
				</h1>
				<p className={styles.description}>
					<F {...messages.noAccessDescription} />
				</p>
			</div>
		</div>
	)
}

function joinErrorMessage(error: UnoJoinError) {
	switch (error) {
		case 'reserved':
			return messages.inviteReserved
		case 'network':
			return messages.inviteNetwork
		default:
			return messages.inviteInvalid
	}
}

/**
 * The join screen behind an invite link. The invite is resolved first so the card can name where
 * the link leads — a forwarded link with no context is otherwise indistinguishable from a broken one.
 */
export function TlaJoinGate({ token, onJoined }: { token: string; onJoined(): void }) {
	const [invite, setInvite] = useState<UnoInviteInfo | null | 'loading'>('loading')
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [error, setError] = useState<UnoJoinError | null>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)

	const nameLabel = useMsg(messages.nameLabel)
	const namePlaceholder = useMsg(messages.namePlaceholder)
	const emailLabel = useMsg(messages.emailLabel)
	const emailPlaceholder = useMsg(messages.emailPlaceholder)

	useEffect(() => {
		let isCancelled = false
		getUnoInviteInfo(token).then((info) => {
			if (!isCancelled) setInvite(info)
		})
		return () => {
			isCancelled = true
		}
	}, [token])

	if (invite === 'loading') {
		return (
			<div className={styles.gate}>
				<div className={styles.card}>
					<p className={styles.description}>
						<F {...messages.loading} />
					</p>
				</div>
			</div>
		)
	}

	if (!invite) return <TlaNoAccessGate />

	const target = invite.boardName
		? `${invite.workspaceName} / ${invite.boardName}`
		: invite.workspaceName

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault()
		const trimmedName = name.trim()
		const trimmedEmail = email.trim()
		if (!trimmedName || !trimmedEmail || isSubmitting) return
		setIsSubmitting(true)
		setError(null)
		const result = await acceptUnoInvite(token, trimmedName, trimmedEmail)
		setIsSubmitting(false)
		if (result.ok) {
			onJoined()
			return
		}
		setError(result.error)
	}

	return (
		<div className={styles.gate}>
			<form className={styles.card} onSubmit={handleSubmit}>
				<h1 className={styles.title}>
					<F {...messages.joinTitle} values={{ target }} />
				</h1>
				<p className={styles.description}>
					<F {...messages.joinDescription} />
				</p>
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
				{error && (
					<p className={styles.error}>
						<F {...joinErrorMessage(error)} />
					</p>
				)}
				<button type="submit" className={styles.submit} disabled={isSubmitting}>
					<F {...(isSubmitting ? messages.joining : messages.join)} />
				</button>
			</form>
		</div>
	)
}

function adminErrorMessage(error: UnoAdminLoginError) {
	switch (error) {
		case 'locked':
			return messages.adminLocked
		case 'network':
			return messages.inviteNetwork
		default:
			return messages.adminDenied
	}
}

/** Exchanges the deployment's admin secret for a session. The address is fixed and not asked for. */
export function TlaAdminLoginGate({ onSignedIn }: { onSignedIn(): void }) {
	const [secret, setSecret] = useState('')
	const [error, setError] = useState<UnoAdminLoginError | null>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)
	const secretLabel = useMsg(messages.adminSecretLabel)

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault()
		if (!secret || isSubmitting) return
		setIsSubmitting(true)
		setError(null)
		const result = await signInUnoAdmin(secret)
		setIsSubmitting(false)
		if (result.ok) {
			onSignedIn()
			return
		}
		setSecret('')
		setError(result.error)
	}

	return (
		<div className={styles.gate}>
			<form className={styles.card} onSubmit={handleSubmit}>
				<h1 className={styles.title}>
					<F {...messages.adminTitle} />
				</h1>
				<p className={styles.description}>
					<F {...messages.adminDescription} />
				</p>
				<label className={styles.field}>
					<span>{secretLabel}</span>
					<input
						type="password"
						required
						autoFocus
						autoComplete="current-password"
						value={secret}
						onChange={(e) => setSecret(e.target.value)}
					/>
				</label>
				{error && (
					<p className={styles.error}>
						<F {...adminErrorMessage(error)} />
					</p>
				)}
				<button type="submit" className={styles.submit} disabled={isSubmitting}>
					<F {...messages.adminSignIn} />
				</button>
			</form>
		</div>
	)
}

const emptyMessages = defineMessages({
	adminTitle: { defaultMessage: 'Nothing here yet' },
	adminDescription: {
		defaultMessage:
			'Create a workspace to start. Boards live inside workspaces, and invites point at either.',
	},
	workspaceNameLabel: { defaultMessage: 'Workspace name' },
	workspaceNamePlaceholder: { defaultMessage: 'Design' },
	create: { defaultMessage: 'Create workspace' },
	memberTitle: { defaultMessage: 'No boards yet' },
	memberDescription: {
		defaultMessage:
			'You are signed in, but nothing has been shared with you yet. Ask for an invite link to a workspace or a board.',
	},
})

/**
 * What a signed-in browser sees when the directory has no board for it: the admin's first-run
 * workspace form, or an explanation for everyone else. Both exist because the editor needs a board
 * id to mount, so there is no version of this that is just an empty sidebar.
 */
export function TlaEmptyDirectoryGate({ isAdmin }: { isAdmin: boolean }) {
	const [name, setName] = useState('')
	const [isSubmitting, setIsSubmitting] = useState(false)
	const workspaceNameLabel = useMsg(emptyMessages.workspaceNameLabel)
	const workspaceNamePlaceholder = useMsg(emptyMessages.workspaceNamePlaceholder)

	if (!isAdmin) {
		return (
			<div className={styles.gate}>
				<div className={styles.card}>
					<h1 className={styles.title}>
						<F {...emptyMessages.memberTitle} />
					</h1>
					<p className={styles.description}>
						<F {...emptyMessages.memberDescription} />
					</p>
				</div>
			</div>
		)
	}

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault()
		const trimmed = name.trim()
		if (!trimmed || isSubmitting) return
		setIsSubmitting(true)
		// A workspace with no board still can't be opened, so the first board comes with it.
		if (await createUnoWorkspace(trimmed)) {
			const workspace = getUnoSessionState().get()
			if (workspace.status === 'ready') {
				const created = workspace.directory.workspaces.find((w) => w.boards.length === 0)
				if (created) await createUnoBoard(created.id, 'Board 1')
			}
		}
		setIsSubmitting(false)
		setName('')
	}

	return (
		<div className={styles.gate}>
			<form className={styles.card} onSubmit={handleSubmit}>
				<h1 className={styles.title}>
					<F {...emptyMessages.adminTitle} />
				</h1>
				<p className={styles.description}>
					<F {...emptyMessages.adminDescription} />
				</p>
				<label className={styles.field}>
					<span>{workspaceNameLabel}</span>
					<input
						type="text"
						required
						autoFocus
						value={name}
						placeholder={workspaceNamePlaceholder}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<button type="submit" className={styles.submit} disabled={isSubmitting}>
					<F {...emptyMessages.create} />
				</button>
			</form>
		</div>
	)
}
