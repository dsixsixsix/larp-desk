import classNames from 'classnames'
import { useBoardSession } from '../../providers/TlaBoardSessionProvider'
import { defineMessages, useIntl, useMsg } from '../../utils/i18n'
import styles from './presence.module.css'

/** Past this, the row turns into "+N" rather than growing across the header. */
const MAX_AVATARS = 4

const messages = defineMessages({
	onThisBoard: { defaultMessage: '{count, plural, one {# person} other {# people}} on this board' },
	overflow: { defaultMessage: '{count} more' },
	overflowBadge: { defaultMessage: '+{count}' },
	speaking: { defaultMessage: '{name} is speaking' },
	you: { defaultMessage: 'You' },
})

/** Initials for the avatar circle: first letters of the first two words, or the first letter. */
function getInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return '?'
	if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
	return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * Who else is on this board, as a stack of avatars in the header — the Google Docs arrangement,
 * for the same reason: the count matters at a glance, the names only on demand.
 *
 * The ring around an avatar is the speaking indicator (see the voice chat in
 * TlaBoardSessionProvider). It lives here rather than somewhere of its own because "who is here"
 * and "who is talking" are the same question asked half a second apart.
 */
export function TlaBoardParticipants() {
	const { participants, selfId, isConnected } = useBoardSession()
	const intl = useIntl()
	const youLbl = useMsg(messages.you)

	// A board you're alone on doesn't need a presence row telling you so.
	if (!isConnected || participants.length < 2) return null

	// The local user goes first so their own avatar doesn't move as others come and go.
	const ordered = [...participants].sort((a, b) => {
		if (a.id === selfId) return -1
		if (b.id === selfId) return 1
		return a.name.localeCompare(b.name)
	})
	const shown = ordered.slice(0, MAX_AVATARS)
	const overflow = ordered.length - shown.length

	return (
		<div
			className={styles.participants}
			data-testid="tla-board-participants"
			aria-label={intl.formatMessage(messages.onThisBoard, { count: participants.length })}
		>
			{shown.map((participant) => {
				const isSelf = participant.id === selfId
				const label = isSelf ? `${participant.name} (${youLbl})` : participant.name
				return (
					<div
						key={participant.id}
						className={classNames(styles.avatar, {
							[styles.avatarSpeaking]: participant.isSpeaking,
						})}
						style={{ backgroundColor: participant.color }}
						title={
							participant.isSpeaking
								? intl.formatMessage(messages.speaking, { name: label })
								: label
						}
						data-speaking={participant.isSpeaking}
					>
						<span className={styles.avatarInitials}>{getInitials(participant.name)}</span>
						{participant.isMicOn && <span className={styles.avatarMic} aria-hidden />}
					</div>
				)
			})}
			{overflow > 0 && (
				<div
					className={classNames(styles.avatar, styles.avatarOverflow)}
					title={intl.formatMessage(messages.overflow, { count: overflow })}
				>
					<span className={styles.avatarInitials}>
						{intl.formatMessage(messages.overflowBadge, { count: overflow })}
					</span>
				</div>
			)}
			<span className={styles.count} data-testid="tla-board-participant-count">
				{participants.length}
			</span>
		</div>
	)
}
