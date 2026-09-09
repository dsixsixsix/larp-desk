/**
 * A stand-in for `next/navigation` and `next/compat/router`, aliased in vite.config.ts.
 *
 * `@clerk/elements` imports both at the top of its sign-in and sign-up entry points, to support
 * being mounted in a Next app. It declares `next` as an optional peer dependency, but the imports
 * are static, so vite's dependency optimizer has to resolve them whether or not the code runs —
 * and this is a vite SPA with no `next` installed. Without these aliases the optimizer fails the
 * whole module ("Could not resolve next/navigation") and every page that pulls in the sign-in
 * dialog dies on load.
 *
 * Nothing here should ever be called: `SignIn.Root` picks its router from its `routing` prop, and
 * we pass `routing="virtual"`, which selects Clerk's own in-memory router instead of the Next one.
 * The throws exist so that a future change to that prop fails loudly here rather than somewhere
 * downstream of an undefined pathname.
 */
function notInNext(hook: string): never {
	throw new Error(
		`${hook} was called, but this app is not a Next app. Clerk Elements should be using its ` +
			`virtual router — check that <SignIn.Root routing="virtual"> is still set.`
	)
}

export function useRouter(): never {
	notInNext('useRouter')
}

export function usePathname(): never {
	notInNext('usePathname')
}

export function useSearchParams(): never {
	notInNext('useSearchParams')
}

export function useParams(): never {
	notInNext('useParams')
}
