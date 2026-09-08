import { useMemo } from 'react'
import { tokenizeJson } from './jsonHighlight'
import styles from './file.module.css'

/** Past this the highlighter's per-token spans cost more than they're worth; show it plain. */
const MAX_HIGHLIGHT_LENGTH = 500_000

/**
 * A JSON file the way an editor shows it: line numbers down the side, one colour per token kind.
 *
 * The colours are the same roles a code editor assigns — keys, strings, numbers, literals and
 * punctuation each distinct — so the shape of the document is readable without reading it.
 */
export function JsonView({ source }: { source: string }) {
	const tokens = useMemo(
		() => (source.length > MAX_HIGHLIGHT_LENGTH ? null : tokenizeJson(source)),
		[source]
	)
	const lineCount = useMemo(() => source.split('\n').length, [source])

	if (!tokens) return <pre className={styles.viewerText}>{source}</pre>

	return (
		<div className={styles.codeView} data-testid="tla-json-view">
			<div className={styles.codeGutter} aria-hidden>
				{Array.from({ length: lineCount }, (_, i) => (
					<div key={i}>{i + 1}</div>
				))}
			</div>
			<pre className={styles.codeBody}>
				{tokens.map((token, i) =>
					token.type === 'whitespace' ? (
						token.value
					) : (
						<span key={i} className={styles[`json_${token.type}`]}>
							{token.value}
						</span>
					)
				)}
			</pre>
		</div>
	)
}
