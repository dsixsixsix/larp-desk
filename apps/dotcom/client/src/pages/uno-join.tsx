import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { routes } from '../routeDefs'
import { TlaJoinGate, TlaNoAccessGate } from '../tla/components/TlaIdentityGate/TlaIdentityGate'
import { TlaAnonLayout } from '../tla/layouts/TlaAnonLayout/TlaAnonLayout'

/** `/join/:token` — the whole of sign-up. See TlaJoinGate. */
export function Component() {
	const { token } = useParams<{ token: string }>()
	const navigate = useNavigate()
	const onJoined = useCallback(() => navigate(routes.tlaRoot(), { replace: true }), [navigate])

	return (
		<TlaAnonLayout>
			{token ? <TlaJoinGate token={token} onJoined={onJoined} /> : <TlaNoAccessGate />}
		</TlaAnonLayout>
	)
}
