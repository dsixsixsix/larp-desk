/**
 * A stand-in for `@clerk/clerk-react` that reports "signed out, and finished loading".
 *
 * Aliased over the real package only when `VITE_DISABLE_AUTH=1` (see vite.config.ts), so the app
 * can be run locally without Clerk credentials — for looking at the canvas, the editor chrome and
 * anything else that doesn't need an account. Nothing in `src/` knows about it.
 *
 * What you get in this mode is the signed-out app: the local scratch canvas. Everything behind an
 * account — the sidebar, workspaces, boards, sharing — needs the real backend (Clerk, postgres,
 * zero-cache) and is simply absent, not stubbed. Opening the sign-in dialog will throw, because
 * `@clerk/elements` is still the real package and has no Clerk to talk to.
 */
import { ReactNode } from 'react'

export function ClerkProvider({ children }: { children: ReactNode }) {
	return <>{children}</>
}

export function useAuth() {
	return {
		isLoaded: true,
		isSignedIn: false,
		userId: null,
		sessionId: null,
		orgId: null,
		orgRole: null,
		orgSlug: null,
		actor: null,
		has: () => false,
		getToken: async () => null,
		signOut: async () => {},
	}
}

export function useUser() {
	return { isLoaded: true, isSignedIn: false, user: null }
}

export function useClerk() {
	return {
		loaded: true,
		user: null,
		session: null,
		client: null,
		buildSignInUrl: () => '/',
		setActive: async () => {},
		openSignIn: () => {},
		redirectToSignIn: async () => {},
		signOut: async () => {},
	}
}

export function useSignIn() {
	return { isLoaded: false, signIn: undefined, setActive: undefined }
}
