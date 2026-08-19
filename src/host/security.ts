/**
 * Loopback trust fence shared by the HTTP/SSE routes and the terminal/LSP
 * WebSocket upgrade handlers.
 *
 * HTTP/SSE keep the original lenient behavior (a missing Origin header is
 * allowed, matching how the DSH GUI issues its own fetch calls). WebSocket
 * upgrades use the strict mode (`requireOrigin = true`): browsers always send
 * an Origin header on the handshake, so an upgrade without a same-origin
 * Origin is refused rather than defaulted open.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Loopback + Host + Origin (+ Sec-Fetch-Site) trust check.
 *  @param requireOrigin - when true, a missing Origin header is a rejection
 *  (used for WebSocket upgrades; conservative by design). */
export function isLoopbackRequest(request: IncomingMessage, requireOrigin = false): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return !requireOrigin
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Reject a WebSocket upgrade: 403 then destroy the raw socket. */
export function rejectUpgrade(socket: Duplex): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  socket.destroy()
}
