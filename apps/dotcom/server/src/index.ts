import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { UNO_SESSION_QUERY_PARAM } from '@tldraw/dotcom-shared'
import { WebSocketServer } from 'ws'
import { AssetStore } from './assets/store'
import { configWarnings, readConfig } from './config'
import { UnoDirectoryService } from './directory/directory'
import { SqliteDirectoryDatabase } from './directory/sqlite'
import { AppContext } from './http/context'
import { clientIp, toRequest, writeResponse } from './http/node'
import { handleRequest } from './http/router'
import { PresenceRegistry } from './presence/registry'
import { MAX_MESSAGE_BYTES } from './presence/room'

const config = readConfig()

for (const warning of configWarnings(config)) console.warn('[config]', warning)

const database = new SqliteDirectoryDatabase(config.databasePath)
const presence = new PresenceRegistry(config)
const directory = new UnoDirectoryService(database, config, presence)
const context: AppContext = {
	config,
	directory,
	presence,
	assets: config.s3 ? new AssetStore(config.s3) : undefined,
}

const server = createServer((req, res) => {
	void (async () => {
		try {
			const response = await handleRequest(
				toRequest(req, config.trustProxy),
				context,
				clientIp(req, config.trustProxy)
			)
			await writeResponse(res, response)
		} catch (error) {
			console.error('[server]', error)
			if (!res.headersSent) res.writeHead(500)
			res.end()
		}
	})()
})

/**
 * `noServer` because the upgrade is authorized before a socket exists: a caller who may not open
 * this board should be answered with an HTTP status, not handed a WebSocket that is closed a moment
 * later. `maxPayload` is the same bound the room applies per frame, enforced a layer lower so an
 * oversized frame is refused by the protocol rather than read and dropped.
 */
const websockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

/**
 * Board ids are minted by the directory, so nothing legitimate needs more than this alphabet. On
 * Cloudflare this also stopped a caller conjuring Durable Objects by name; here it is what keeps a
 * path segment from becoming a room key of the caller's choosing.
 */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/
const PRESENCE_PATH = /^\/uno\/board\/([^/]+)\/presence$/

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
	void (async () => {
		try {
			const url = new URL(req.url ?? '/', 'http://localhost')
			const match = PRESENCE_PATH.exec(url.pathname)
			if (!match) return reject(socket, 404, 'Not Found')

			const boardId = decodeURIComponent(match[1])
			if (!BOARD_ID.test(boardId)) return reject(socket, 404, 'Not Found')

			// A websocket cannot carry an Authorization header, so the session token rides in the
			// query string on this one route.
			const token = url.searchParams.get(UNO_SESSION_QUERY_PARAM) ?? ''
			const userId = await directory.authorizeBoard(token, boardId)
			// Not 403: a board someone has been removed from should look the same to them as one that
			// was never theirs, and the client treats both as "this board is gone".
			if (!userId) return reject(socket, 404, 'Not Found')

			websockets.handleUpgrade(req, socket, head, (ws) => {
				// Passed in rather than re-derived inside the room: it holds no directory of its own,
				// and this is what lets it close the right sockets when a membership is revoked.
				presence.join(boardId, ws, userId)
			})
		} catch (error) {
			console.error('[upgrade]', error)
			reject(socket, 500, 'Internal Server Error')
		}
	})()
})

function reject(socket: Duplex, status: number, message: string) {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`)
	socket.destroy()
}

server.listen(config.port, config.host, () => {
	// stdout rather than console.log, which the repo's lint rules reserve for warn and error.
	process.stdout.write(`[server] listening on http://${config.host}:${config.port}\n`)
})

/**
 * A container stop sends SIGTERM and then waits. Closing the listener first stops new connections
 * while the ones in flight finish; the presence sockets are closed explicitly because an idle
 * WebSocket would otherwise hold the server open until the runtime kills it.
 */
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		if (shuttingDown) return
		shuttingDown = true
		process.stdout.write(`[server] ${signal}, shutting down\n`)
		// 1012 is "service restart", which is what tells the client to reconnect rather than treat
		// this as the board going away.
		presence.closeAll(1012, 'Server restarting')
		server.close(() => {
			database.close()
			process.exit(0)
		})
		// A client holding a keep-alive connection open can outlast the drain; this bounds it.
		setTimeout(() => process.exit(0), 10_000).unref()
	})
}
