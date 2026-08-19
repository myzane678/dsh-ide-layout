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
import { fileURLToPath } from 'node:url'
import { type IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { FsService } from './fs-service.ts'
import { languageIdForPath } from '../core/types.ts'
import { closeWs } from './ws-safe.ts'

/**
 * Server kind → 启动配置：命令 + 参数构造。
 * - ts / py：Node 语言服务器（`process.execPath` 以 Node 模式跑 JS 入口，--stdio）。
 * - ps：PowerShell Editor Services 不是 Node 程序，用 `pwsh` 跑捆绑在插件
 *   vendor/ 的 Start-EditorServices.ps1（-Stdio 走标准输入输出，正合本桥）。
 *   ⚠️ BundledModulesPath 必须指向「包含 PowerShellEditorServices 与
 *   PSScriptAnalyzer 的父目录」（PSES 硬编码找 BundledModulesPath/PSScriptAnalyzer），
 *   不是 PSES 自身目录——指错会导致分析器缺失、启动 CommandNotFound 退出。
 *   vendor 从 GitHub releases / PSGallery 手动更新（.gitignore，不入库）。
 *   ⚠️ 相对路径以**构建产物位置（lib/）**为基准：lib 在插件根下，用 '../vendor'
 *   （= 插件根/vendor）；不要写 '../../vendor'——那是源码 src/host/ 的深度，
 *   打包后运行在 lib/ 会多上跳一级指到父目录（实测 Start-EditorServices.ps1
 *   找不到，PSES 直接 CommandNotFound 退出）。
 */
const SERVER_LAUNCHERS: Record<string, { command: string; args: () => string[] }> = (() => {
  const require = createRequire(import.meta.url)
  const tsEntry = require.resolve('typescript-language-server/lib/cli.mjs')
  const pyEntry = require.resolve('pyright/langserver.index.js')
  const psBundle = fileURLToPath(new URL('../vendor', import.meta.url))
  return {
    ts: { command: process.execPath, args: () => [tsEntry, '--stdio'] },
    py: { command: process.execPath, args: () => [pyEntry, '--stdio'] },
    ps: {
      command: 'pwsh',
      args: () => [
        '-NoLogo', '-NoProfile', '-Command',
        `& '${psBundle}/PowerShellEditorServices/Start-EditorServices.ps1' -Stdio -HostName 'DSH IDE' -HostProfileId 'dsh-ide' -HostVersion '1.0.0' -BundledModulesPath '${psBundle}' -LogLevel Error`,
      ],
    },
  }
})()

/** The server kind for a file path (or null when unsupported). */
export function lspServerForPath(path: string): string | null {
  const language = languageIdForPath(path)
  if (language === null) return null
  if (language === 'python') return 'py'
  if (language === 'powershell') return 'ps'
  return 'ts'
}

/** P1-03：LSP 子进程并发上限 + 单帧大小上限（防资源耗尽）。 */
const LSP_MAX_CONNECTIONS = 8
const LSP_MAX_FRAME_BYTES = 4 * 1024 * 1024
let lspActiveCount = 0

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
      const launcher = SERVER_LAUNCHERS[server]
      if (launcher === undefined) {
        ws.close(1008, `unsupported server kind: ${server}`)
        return
      }
      const gated = await fs.verify(root)
      if (!gated.ok || gated.canonical === undefined) {
        ws.close(1011, gated.error?.message ?? 'root not gated')
        return
      }
      // P1-03：连接数上限——异常/恶意客户端不能批量拉起 LSP 子进程。
      if (lspActiveCount >= LSP_MAX_CONNECTIONS) {
        ws.close(1013, `too many LSP connections (${LSP_MAX_CONNECTIONS})`)
        return
      }
      lspActiveCount += 1
      const bridge: Bridge = {
        child: spawn(launcher.command, launcher.args(), {
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
        if (ws.readyState === WebSocket.OPEN) closeWs(ws, 1011, `language server error: ${error.message}`)
      })
      bridge.child.on('exit', (code, signal) => {
        bridge.exited = true
        // 完整 stderr（去 ANSI 转义）进宿主日志——不截断，排查服务器启动失败
        // 时能看到完整错误（ws reason 只有 123 字节装不下，靠这里留痕）。
        if (bridge.stderrTail !== '') {
          const clean = bridge.stderrTail.replace(/\u001b\[[0-9;]*m/g, '')
          console.error(`[dsh-ide-lsp] ${server} exited (${signal ?? `code ${code ?? '?'}`}): ${clean}`)
          // 把完整 stderr 经 WS 发给客户端（window/logMessage type 3），界面
          // 悬停状态栏即可看到全文——close reason 的 123 字节截断只留一行。
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              method: 'window/logMessage',
              params: { type: 3, message: `[${server}] language server exited: ${clean}` },
            }))
          }
        }
        if (ws.readyState === WebSocket.OPEN) {
          closeWs(ws, 1011, `language server exited (${signal ?? `code ${code ?? '?'}`})${bridge.stderrTail !== '' ? `: ${bridge.stderrTail.trim().split('\n').pop() ?? ''}` : ''}`)
        }
      })
      bridge.child.stdout.on('data', (chunk: Buffer) => {
        bridge.reader.push(chunk, (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        })
      })
      // P1-03：URI 门禁——LSP 请求中的文件 URI 必须位于授权工作区内，
      // 防止语言服务器读取/索引工作区外的文件（Windows 大小写不敏感）。
      // 路径 → file:// URI：保留盘符冒号（E:/work → e:/work），小写化便于比较。
      const rootUriPrefix = 'file:///' + gated.canonical
        .replaceAll('\\', '/')
        .replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`)
        .replace(/\/+$/, '')
      const uriAllowed = (uri: unknown): boolean => {
        if (typeof uri !== 'string') return true
        const norm = decodeURIComponent(uri).toLowerCase()
        return norm.startsWith(rootUriPrefix.toLowerCase())
      }
      ws.on('message', (data) => {
        if (bridge.exited || bridge.child.stdin === null) return
        // P1-03：单帧大小上限（data 可能是 Buffer / ArrayBuffer / Buffer[]）。
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
        if (frame.length > LSP_MAX_FRAME_BYTES) {
          ws.close(1009, 'message too large')
          return
        }
        // P1-03：校验消息内引用的文件 URI（textDocument.uri / uri）。
        try {
          const message = JSON.parse(frame.toString('utf8')) as {
            params?: { textDocument?: { uri?: unknown }; uri?: unknown }
          }
          const params = message.params
          if (params !== undefined && typeof params === 'object') {
            const candidate = params.textDocument?.uri ?? params.uri
            if (candidate !== undefined && !uriAllowed(candidate)) {
              ws.close(1008, 'uri outside workspace')
              return
            }
          }
        } catch {
          // 非 JSON（keep-alive 等）放行；JSON 解析失败由下游处理。
        }
        bridge.child.stdin.write(`Content-Length: ${frame.length}\r\n\r\n`)
        bridge.child.stdin.write(frame)
      })
      ws.on('close', () => {
        lspActiveCount = Math.max(0, lspActiveCount - 1)
        if (!bridge.exited) {
          try {
            bridge.child.kill()
          } catch {
            // Already gone.
          }
        }
      })
    } catch (error) {
      closeWs(ws, 1011, error instanceof Error ? error.message : String(error))
    }
  })()
}
