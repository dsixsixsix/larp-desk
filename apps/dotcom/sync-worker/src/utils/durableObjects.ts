import { ROOM_PREFIX } from '@tldraw/dotcom-shared'
import { TLFileDurableObject } from '../TLFileDurableObject'
import type { TLFileEffectProcessor } from '../TLFileEffectProcessor'
import { TLLoggerDurableObject } from '../TLLoggerDurableObject'
import { Environment } from '../types'

export function getFileEffectProcessor(env: Environment) {
	return env.TL_FILE_EFFECTS.get(env.TL_FILE_EFFECTS.idFromName('0'), {
		locationHint: 'weur',
	}) as any as TLFileEffectProcessor
}

export function getLogger(env: Environment) {
	return env.TL_LOGGER.get(env.TL_LOGGER.idFromName('logger')) as any as TLLoggerDurableObject
}

export function getRoomDurableObjectId(env: Environment, roomId: string) {
	return env.TLDR_DOC.idFromName(`/${ROOM_PREFIX}/${roomId}`)
}

export function getRoomDurableObject(env: Environment, roomId: string) {
	return env.TLDR_DOC.get(getRoomDurableObjectId(env, roomId)) as any as TLFileDurableObject
}

export function getRoomDurableObjectById(env: Environment, objectId: string) {
	return env.TLDR_DOC.get(env.TLDR_DOC.idFromString(objectId)) as any as TLFileDurableObject
}

/**
 * The one directory object. Named rather than derived from anything, because there is exactly one
 * account system and every question it answers spans all of it (see UnoDirectoryDurableObject).
 */
export function getUnoDirectory(env: Environment) {
	return env.UNO_DIRECTORY.get(env.UNO_DIRECTORY.idFromName('uno-directory'))
}
