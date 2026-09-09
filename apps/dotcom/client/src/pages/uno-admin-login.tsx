import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { routes } from '../routeDefs'
import { TlaAdminLoginGate } from '../tla/components/TlaIdentityGate/TlaIdentityGate'
import { TlaAnonLayout } from '../tla/layouts/TlaAnonLayout/TlaAnonLayout'

/** `/admin-login` — the deployment secret, exchanged for the one admin session. */
export function Component() {
	const navigate = useNavigate()
	const onSignedIn = useCallback(() => navigate(routes.tlaRoot(), { replace: true }), [navigate])

	return (
		<TlaAnonLayout>
			<TlaAdminLoginGate onSignedIn={onSignedIn} />
		</TlaAnonLayout>
	)
}
