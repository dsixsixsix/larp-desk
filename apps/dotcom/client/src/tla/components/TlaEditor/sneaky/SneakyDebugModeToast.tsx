import { useEffect, useRef } from 'react'
import { useEditor, useLocalStorageState, useToasts, useValue } from 'tldraw'
import { trackEvent } from '../../../../utils/analytics'
import { UI_SURFACES } from '../../../config/uiSurfaces'

const SDK_URL = 'https://tldraw.dev'
const TOAST_ID = 'debug-sdk-toast'
const TOAST_DELAY = 10_000

export function SneakyDebugModeToast() {
	const editor = useEditor()
	const toasts = useToasts()
	const toastsRef = useRef(toasts)
	toastsRef.current = toasts
	const [showDebugSdkToast, setShowDebugSdkToast] = useLocalStorageState('showDebugSdkToast', true)

	const isDebugMode = useValue('isDebugMode', () => editor.getInstanceState().isDebugMode, [editor])

	useEffect(() => {
		if (!UI_SURFACES.sdkDebugToast) return
		if (!isDebugMode) {
			toastsRef.current.removeToast(TOAST_ID)
			return
		}
		if (!showDebugSdkToast) return

		const timeout = setTimeout(() => {
			toastsRef.current.addToast({
				id: TOAST_ID,
				description: 'Built on the tldraw SDK. Want to build with it too?',
				keepOpen: true,
				actions: [
					{
						type: 'primary',
						label: 'Get started',
						onClick() {
							trackEvent('debug-sdk-toast-clicked')
							window.open(SDK_URL, '_blank')
						},
					},
				],
			})
			setShowDebugSdkToast(false)
		}, TOAST_DELAY)

		return () => clearTimeout(timeout)
	}, [isDebugMode, showDebugSdkToast, setShowDebugSdkToast])

	return null
}
