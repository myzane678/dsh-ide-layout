/**
 * Terminal WebSocket upgrade for the IDE: /dsh-ide/ws/terminal?root=...
 * Wire protocol (shared with the browser half): input frames are raw text,
 * resize frames are JSON `{type:'resize',cols,rows}`, and a close frame
 * `{type:'close'}` releases the pty immediately. On connect the host replays
 * the transcript, then streams live output; a bare socket drop (refresh,
 * tab switch) schedules the pty's destruction after the reconnect grace so
 * a quick reconnect keeps the SAME shell. Reference: dsh-better-sidebar
 * attachTerminal (MIT), trimmed to one terminal per root.
 */

import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { FsService } from './fs-service.ts'
import type { PtyService } from './pty-service.ts'

/** Grace after a bare socket drop before the shell is killed. */
const RECONNECT_GRACE_MS = 30_000

/** Parse a raw frame: a recognized JSON control or raw terminal input. */
function parseFrame(text: string): { type: 'resize' | 'close'; cols?: number; rows?: number } | null {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.type === 'close') return { type: 'close' }
  if (
    record.type === 'resize'
    && typeof record.cols === 'number' && typeof record.rows === 'number'
    && Number.isFinite(record.cols) && Number.isFinite(record.rows)
  ) {
    return { type: 'resize', cols: record.cols, rows: record.rows }
  }
  return null
}

/** Wire one terminal socket to its pty (replay transcript, pump both ways). */
export function attachTerminalSocket(
  fs: FsService,
  pty: PtyService,
  req: IncomingMessage,
  ws: WebSocket,
): void {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const root = url.searchParams.get('root')
      if (root === null || root === '') {
        ws.close(1008, '?root= is required')
        return
      }
      const gated = await fs.verify(root)
      if (!gated.ok || gated.canonical === undefined) {
        ws.close(1011, gated.error?.message ?? 'root not gated')
        return
      }
      const handle = pty.open(gated.canonical, 80, 24)
      // Replay the transcript, then follow live output.
      if (handle.transcript !== '') ws.send(handle.transcript)
      const onData = (data: string): void => {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
          ws.send(data)
        }
      }
      const onExit = ({ exitCode }: { exitCode: number }): void => {
        onData(`\r\n[process exited with code ${String(exitCode)}]\r\n`)
      }
      const dataSub = handle.pty.onData(onData)
      const exitSub = handle.pty.onExit(onExit)
      ws.on('message', (data) => {
        const frame = parseFrame(data.toString('utf8'))
        if (frame !== null && frame.type === 'close') {
          pty.scheduleClose(0)
          return
        }
        if (handle.exited) return
        if (frame !== null && frame.type === 'resize') {
          handle.pty.resize(Math.max(2, Math.floor(frame.cols as number)), Math.max(2, Math.floor(frame.rows as number)))
        } else {
          handle.pty.write(data.toString('utf8'))
        }
      })
      ws.on('close', () => {
        dataSub.dispose()
        exitSub.dispose()
        pty.scheduleClose(RECONNECT_GRACE_MS)
      })
    } catch (error) {
      ws.close(1011, error instanceof Error ? error.message : String(error))
    }
  })()
}
