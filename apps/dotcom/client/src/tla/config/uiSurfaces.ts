/**
 * Which inherited chrome the app still renders.
 *
 * The product is the board flow: pick a workspace, pick a board, draw. Everything
 * switched off here is surface that came with the tldraw.com app and competes with
 * that flow — SDK marketing, feedback funnels, support links. The components stay
 * live and typechecked so a surface can come back by flipping one flag, rather than
 * being resurrected from git history.
 *
 * Legal surfaces are deliberately absent from this list: they are compliance obligations, not
 * product chrome, and must not be switchable. Cookie settings are not flagged — they moved out of
 * the page menu and into the settings dialog's "Local data" section, because withdrawing consent
 * has to stay as easy as giving it. The legal summary linked to tldraw.com's own terms, which do
 * not describe this app, and was removed rather than hidden.
 */
export const UI_SURFACES = {
	/** "Built on the tldraw SDK" row at the bottom of the sidebar. */
	sdkPromoLink: false,
	/** The same pitch as a dismissible overlay for signed-out visitors. */
	anonSdkOverlay: false,
	/** "Send feedback" — sidebar button and main-menu item. */
	feedback: false,
	/** "User manual" main-menu item, which points at tldraw's support site. */
	userManual: false,
	/** Toast nudging a debug-mode user toward tldraw.dev. */
	sdkDebugToast: false,
} as const
