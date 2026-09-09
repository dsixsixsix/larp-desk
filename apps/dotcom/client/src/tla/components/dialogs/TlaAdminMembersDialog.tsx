import { UnoInviteScope, UnoInviteSummary, UnoMemberSummary } from '@tldraw/dotcom-shared'
import classNames from 'classnames'
import { useCallback, useEffect, useState } from 'react'
import {
	TldrawUiButton,
	TldrawUiButtonLabel,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogFooter,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
} from 'tldraw'
import { defineMessages, F, useIntl, useMsg } from '../../utils/i18n'
import {
	getUnoInviteUrl,
	listUnoInvites,
	listUnoMembers,
	removeUnoMember,
	removeUnoUser,
	revokeUnoInvite,
} from '../../utils/unoDirectory'
import { TlaIcon } from '../TlaIcon/TlaIcon'
import styles from './dialogs.module.css'

const messages = defineMessages({
	title: { defaultMessage: 'People' },
	people: { defaultMessage: 'People' },
	links: { defaultMessage: 'Invite links' },
	loading: { defaultMessage: 'Loading…' },
	empty: { defaultMessage: 'Nobody has accepted an invite yet.' },
	noLinks: { defaultMessage: 'No invite links yet. Create one from the workspace switcher.' },
	admin: { defaultMessage: 'Admin' },
	everyBoard: { defaultMessage: 'every board' },
	noMemberships: { defaultMessage: 'No workspaces or boards' },
	remove: { defaultMessage: 'Remove' },
	removeFrom: { defaultMessage: 'Remove {name} from {target}?' },
	removeUser: { defaultMessage: 'Remove from the service' },
	removeUserConfirm: {
		defaultMessage: 'Remove {name} from every workspace and board, and delete their account?',
	},
	cancel: { defaultMessage: 'Cancel' },
	revoke: { defaultMessage: 'Revoke' },
	revokeConfirm: { defaultMessage: 'Revoke this link? People already in keep their access.' },
	accepted: { defaultMessage: '{count, plural, one {# use} other {# uses}}' },
	copy: { defaultMessage: 'Copy' },
	copied: { defaultMessage: 'Copied' },
	failed: { defaultMessage: 'Could not load. Check your connection.' },
	close: { defaultMessage: 'Close' },
})

type Tab = 'people' | 'links'

/**
 * The admin's view of who is in the service: one row per person, with the workspaces and boards
 * they belong to, and the invite links that let people in.
 *
 * The two memberships read differently on purpose. A workspace row means every board in it,
 * including ones created later; a board row means that board alone. Removing either takes effect
 * immediately — the server closes any live session the person has on the boards they just lost.
 */
export function TlaAdminMembersDialog({ onClose }: { onClose(): void }) {
	const [tab, setTab] = useState<Tab>('people')
	const [members, setMembers] = useState<UnoMemberSummary[] | null>(null)
	const [invites, setInvites] = useState<UnoInviteSummary[] | null>(null)
	const [hasFailed, setHasFailed] = useState(false)

	const titleLbl = useMsg(messages.title)
	const peopleLbl = useMsg(messages.people)
	const linksLbl = useMsg(messages.links)

	useEffect(() => {
		let isCancelled = false
		Promise.all([listUnoMembers(), listUnoInvites()]).then(([nextMembers, nextInvites]) => {
			if (isCancelled) return
			if (!nextMembers) {
				setHasFailed(true)
				return
			}
			setMembers(nextMembers)
			setInvites(nextInvites)
		})
		return () => {
			isCancelled = true
		}
	}, [])

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'people', label: peopleLbl },
		{ id: 'links', label: linksLbl },
	]

	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>{titleLbl}</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody className={styles.settingsBody}>
				<nav className={styles.settingsNav} aria-label={titleLbl}>
					{tabs.map((item) => (
						<button
							key={item.id}
							type="button"
							className={styles.settingsNavItem}
							aria-current={tab === item.id}
							data-testid={`tla-admin-tab-${item.id}`}
							onClick={() => setTab(item.id)}
						>
							{item.label}
						</button>
					))}
				</nav>
				<div className={styles.settingsPanel} data-testid={`tla-admin-panel-${tab}`}>
					{hasFailed ? (
						<div className={styles.memberEmptyNote}>
							<F {...messages.failed} />
						</div>
					) : tab === 'people' ? (
						<PeopleTab members={members} onChange={setMembers} />
					) : (
						<LinksTab invites={invites} onChange={setInvites} />
					)}
				</div>
			</TldrawUiDialogBody>
			<TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<TldrawUiButton type="normal" onClick={onClose}>
					<TldrawUiButtonLabel>
						<F {...messages.close} />
					</TldrawUiButtonLabel>
				</TldrawUiButton>
			</TldrawUiDialogFooter>
		</>
	)
}

/**
 * A removal waiting to be confirmed: one membership when `scope` is set, and the whole account
 * when it is not.
 */
interface PendingRemoval {
	userId: string
	scope: UnoInviteScope | null
	scopeId: string
	prompt: string
}

function PeopleTab({
	members,
	onChange,
}: {
	members: UnoMemberSummary[] | null
	onChange(members: UnoMemberSummary[]): void
}) {
	const removeLbl = useMsg(messages.remove)
	const adminLbl = useMsg(messages.admin)
	const everyBoardLbl = useMsg(messages.everyBoard)
	const noMembershipsLbl = useMsg(messages.noMemberships)
	const removeUserLbl = useMsg(messages.removeUser)
	const cancelLbl = useMsg(messages.cancel)
	const intl = useIntl()
	// At most one removal is ever pending, so this is one descriptor rather than per-row state.
	const [pending, setPending] = useState<PendingRemoval | null>(null)

	const confirmRemoval = useCallback(async () => {
		if (!pending) return
		const next = pending.scope
			? await removeUnoMember(pending.userId, pending.scope, pending.scopeId)
			: await removeUnoUser(pending.userId)
		setPending(null)
		if (next) onChange(next)
	}, [pending, onChange])

	if (!members) {
		return (
			<div className={styles.memberEmptyNote}>
				<F {...messages.loading} />
			</div>
		)
	}

	if (members.length === 0) {
		return (
			<div className={styles.memberEmptyNote}>
				<F {...messages.empty} />
			</div>
		)
	}

	return (
		<div className={styles.memberList} data-testid="tla-admin-member-list">
			{members.map((member) => (
				<div key={member.user.id} className={styles.memberRow}>
					<div className={styles.memberIdentity}>
						<span className={styles.memberName}>{member.user.name}</span>
						<span className={styles.memberEmail}>{member.user.email}</span>
						{member.user.isAdmin && <span className={styles.memberBadge}>{adminLbl}</span>}
					</div>
					{member.user.isAdmin ? (
						// The admin is not a membership row: they can open everything by definition, and
						// there is nothing here to take away.
						<div className={styles.memberEmptyNote}>{everyBoardLbl}</div>
					) : (
						<>
							<div className={styles.memberships}>
								{member.workspaces.map((workspace) => (
									<span key={`w-${workspace.id}`} className={styles.membership}>
										{workspace.name}
										<button
											type="button"
											className={styles.membershipRemove}
											aria-label={`${removeLbl}: ${workspace.name}`}
											title={removeLbl}
											data-testid="tla-admin-remove-membership"
											onClick={() =>
												setPending({
													userId: member.user.id,
													scope: 'workspace',
													scopeId: workspace.id,
													prompt: intl.formatMessage(messages.removeFrom, {
														name: member.user.name,
														target: workspace.name,
													}),
												})
											}
										>
											<TlaIcon icon="close" />
										</button>
									</span>
								))}
								{member.boards.map((board) => {
									// A board membership is shown with its workspace, so it reads the same as
									// the breadcrumb in the switcher and can't be mistaken for a workspace one.
									const label = `${board.workspaceName} / ${board.name}`
									return (
										<span key={`b-${board.id}`} className={styles.membership}>
											{label}
											<button
												type="button"
												className={styles.membershipRemove}
												aria-label={`${removeLbl}: ${board.name}`}
												title={removeLbl}
												data-testid="tla-admin-remove-membership"
												onClick={() =>
													setPending({
														userId: member.user.id,
														scope: 'board',
														scopeId: board.id,
														prompt: intl.formatMessage(messages.removeFrom, {
															name: member.user.name,
															target: label,
														}),
													})
												}
											>
												<TlaIcon icon="close" />
											</button>
										</span>
									)
								})}
								{member.workspaces.length === 0 && member.boards.length === 0 && (
									<span className={styles.memberEmptyNote}>{noMembershipsLbl}</span>
								)}
							</div>
							<div className={styles.settingsActionRow}>
								<button
									type="button"
									className={styles.inlineButton}
									data-testid="tla-admin-remove-user"
									onClick={() =>
										setPending({
											userId: member.user.id,
											scope: null,
											scopeId: '',
											prompt: intl.formatMessage(messages.removeUserConfirm, {
												name: member.user.name,
											}),
										})
									}
								>
									{removeUserLbl}
								</button>
							</div>
						</>
					)}
					{pending?.userId === member.user.id && (
						<div className={styles.settingsActionRow}>
							<span className={styles.memberEmptyNote}>{pending.prompt}</span>
							<button
								type="button"
								className={classNames(styles.inlineButton, styles.inlineButtonDanger)}
								data-testid="tla-admin-remove-confirm"
								onClick={confirmRemoval}
							>
								{removeLbl}
							</button>
							<button
								type="button"
								className={styles.inlineButton}
								onClick={() => setPending(null)}
							>
								{cancelLbl}
							</button>
						</div>
					)}
				</div>
			))}
		</div>
	)
}

function LinksTab({
	invites,
	onChange,
}: {
	invites: UnoInviteSummary[] | null
	onChange(invites: UnoInviteSummary[]): void
}) {
	const [copiedToken, setCopiedToken] = useState<string | null>(null)
	const [confirmingToken, setConfirmingToken] = useState<string | null>(null)
	const copyLbl = useMsg(messages.copy)
	const copiedLbl = useMsg(messages.copied)
	const revokeLbl = useMsg(messages.revoke)
	const cancelLbl = useMsg(messages.cancel)
	const revokeConfirmLbl = useMsg(messages.revokeConfirm)

	useEffect(() => {
		if (!copiedToken) return
		const timeout = window.setTimeout(() => setCopiedToken(null), 2000)
		return () => window.clearTimeout(timeout)
	}, [copiedToken])

	if (!invites) {
		return (
			<div className={styles.memberEmptyNote}>
				<F {...messages.loading} />
			</div>
		)
	}

	if (invites.length === 0) {
		return (
			<div className={styles.memberEmptyNote}>
				<F {...messages.noLinks} />
			</div>
		)
	}

	return (
		<div className={styles.memberList} data-testid="tla-admin-invite-list">
			{invites.map((invite) => (
				<div key={invite.token} className={styles.memberRow}>
					<div className={styles.memberIdentity}>
						<span className={styles.memberName}>{invite.label}</span>
						<span className={styles.memberEmail}>
							<F {...messages.accepted} values={{ count: invite.acceptedCount }} />
						</span>
					</div>
					<div className={styles.settingsActionRow}>
						<button
							type="button"
							className={styles.inlineButton}
							onClick={async () => {
								const url = getUnoInviteUrl(invite.token)
								try {
									await navigator.clipboard.writeText(url)
									setCopiedToken(invite.token)
								} catch {
									window.prompt(invite.label, url)
								}
							}}
						>
							{copiedToken === invite.token ? copiedLbl : copyLbl}
						</button>
						<button
							type="button"
							className={styles.inlineButton}
							onClick={() => setConfirmingToken(invite.token)}
						>
							{revokeLbl}
						</button>
					</div>
					{confirmingToken === invite.token && (
						<div className={styles.settingsActionRow}>
							<span className={styles.memberEmptyNote}>{revokeConfirmLbl}</span>
							<button
								type="button"
								className={classNames(styles.inlineButton, styles.inlineButtonDanger)}
								data-testid="tla-admin-revoke-confirm"
								onClick={async () => {
									setConfirmingToken(null)
									if (await revokeUnoInvite(invite.token)) {
										onChange(invites.filter((i) => i.token !== invite.token))
									}
								}}
							>
								{revokeLbl}
							</button>
							<button
								type="button"
								className={styles.inlineButton}
								onClick={() => setConfirmingToken(null)}
							>
								{cancelLbl}
							</button>
						</div>
					)}
				</div>
			))}
		</div>
	)
}
