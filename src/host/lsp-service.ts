/**
 * LSP bridge for the IDE: one language-server child process per WebSocket
 * connection (stdio JSON-RPC with Content-Length framing), spawned with the
 * gated workspace root as cwd. The browser half speaks the full LSP protocol
 * over the socket (initialize / didOpen / didChange / completion / …); this
 * service is a pure transport layer: WS text frames in, framed JSON-RPC out
 * to the child's stdin, framed responses pushed back to the socket.
 *
 * One process per connection (disconnect ⇒ kill) keeps state sharing simple
 * and avoids cross-session interference; cold start is ~1s for tsserver, a
 * few seconds for pyright, fine for an editor session. Server resolution uses
 * createRequire so the package stays external to the tsdown bundle.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { type IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { FsService } from './fs-service.ts'
import { languageIdForPath } from '../core/types.ts'

/** Server kind → CLI entry (resolved from this plugin's node_modules). */
const SERVER_ENTRIES: Record<string, string> = (() => {
  const require = createRequire(import.meta.url)
  return {
    ts: require.resolve('typescript-language-server/lib/cli.mjs'),
    py: require.resolve('pyright/langserver.index.js'),
  }
})()

/** The server kind for a file path (or null when unsupported). */
export function lspServerForPath(path: string): string | null {
  const language = languageIdForPath(path)
  if (language === null) return null
  return language === 'python' ? 'py' : 'ts'
}

/** Accumulate stdin chunks and split on Content-Length framing. */
class FrameReader {
  private buffer = Buffer.alloc(0)
  private contentLength: number | null = null

  push(chunk: Buffer, onMessage: (message: unknown) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.contentLength === null) {
        const headEnd = this.buffer.indexOf('\r\n\r\n')
        if (headEnd === -1) return
        const header = this.buffer.subarray(0, headEnd).toString('utf8')
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (match === null) {
          // Malformed header: drop everything up to the next headEnd.
          this.buffer = this.buffer.subarray(headEnd + 4)
          continue
        }
        this.contentLength = Number.parseInt(match[1], 10)
        this.buffer = this.buffer.subarray(headEnd + 4)
      }
      if (this.buffer.length < this.contentLength) return
      const body = this.buffer.subarray(0, this.contentLength).toString('utf8')
      this.buffer = this.buffer.subarray(this.contentLength)
      this.contentLength = null
      try {
        onMessage(JSON.parse(body) as unknown)
      } catch {
        // Malformed JSON body: skip.
      }
    }
  }
}

/** One live bridge: child process + its socket. */
interface Bridge {
  child: ChildProcess
  reader: FrameReader
  socket: WebSocket
  exited: boolean
  /** stderr tail for error reporting (bounded). */
  stderrTail: string
}

/**
 * Spawn the language server for a root and wire it to the socket.
 * @param ws - the WebSocket carrying LSP JSON-RPC frames from the browser.
 */
export function attachLspSocket(fs: FsService, req: IncomingMessage, ws: WebSocket): void {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const root = url.searchParams.get('root')
      if (root === null || root === '') {
        ws.close(1008, '?root= is required')
        return
      }
      const server = url.searchParams.get('server') ?? 'ts'
      const entry = SERVER_ENTRIES[server]
      if (entry === undefined) {
        ws.close(1008, `unsupported server kind: ${server}`)
        return
      }
      const gated = await fs.verify(root)
      if (!gated.ok || gated.canonical === undefined) {
        ws.close(1011, gated.error?.message ?? 'root not gated')
        return
      }
      const bridge: Bridge = {
        child: spawn(process.execPath, [entry, '--stdio'], {
          cwd: gated.canonical,
          // DSH Desktop 是 Electron 宿主：process.execPath 指向 DSH Desktop.exe，
          // 不设 ELECTRON_RUN_AS_NODE 会以 Electron GUI 模式启动脚本 → 立即退出。
          // 该变量让 exe 以 Node 模式跑语言服务器（对普通 Node 宿主无害）。
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        reader: new FrameReader(),
        socket: ws,
        exited: false,
        stderrTail: '',
      }
      if (bridge.child.stdin === null || bridge.child.stdout === null || bridge.child.stderr === null) {
        ws.close(1011, 'server spawn failed: missing stdio')
        return
      }
      bridge.child.stderr.on('data', (chunk: Buffer) => {
        bridge.stderrTail = (bridge.stderrTail + chunk.toString('utf8')).slice(-4096)
      })
      bridge.child.on('error', (error) => {
        bridge.exited = true
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, `language server error: ${error.message}`)
      })
      bridge.child.on('exit', (code, signal) => {
        bridge.exited = true
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, `language server exited (${signal ?? `code ${code ?? '?'}`})${bridge.stderrTail !== '' ? `: ${bridge.stderrTail.trim().split('\n').pop() ?? ''}` : ''}`)
        }
      })
      bridge.child.stdout.on('data', (chunk: Buffer) => {
        bridge.reader.push(chunk, (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        })
      })
      ws.on('message', (data) => {
        if (bridge.exited || bridge.child.stdin === null) return
        const body = Buffer.from(data.toString('utf8'), 'utf8')
        bridge.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
        bridge.child.stdin.write(body)
      })
      ws.on('close', () => {
        if (!bridge.exited) {
          try {
            bridge.child.kill()
          } catch {
            // Already gone.
          }
        }
      })
    } catch (error) {
      ws.close(1011, error instanceof Error ? error.message : String(error))
    }
  })()
}
