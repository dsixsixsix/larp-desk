const UNO_BRANDING_MESSAGE = `

  ██  ██  ███    ██   ████  
  ██  ██  ████   ██  ██  ██ 
  ██  ██  ██ ██  ██  ██  ██ 
  ██  ██  ██  ██ ██  ██  ██ 
  ██████  ██   ████  ██  ██ 
   ████   ██    ███   ████  

	UnoCode — collaborative whiteboard and infinite canvas

	Built on the tldraw SDK (https://tldraw.dev), modified for UnoCode.

`

export function showConsoleBranding() {
	// eslint-disable-next-line no-console
	console.log('%c' + UNO_BRANDING_MESSAGE, 'font-family: monospace; font-weight: normal;')
}
