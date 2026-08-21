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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { type IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { FsService } from './fs-service.ts'
import { languageIdForPath } from '../core/types.ts'
import { closeWs } from './ws-safe.ts'

/** Server kind → 启动配置：命令 + 参数构造。 */
type ServerLauncher = { command: string; args: (root: string) => string[] }

/**
 * 可选的 Java LSP：优先使用 DSH_JAVA_LS_HOME，其次复用本机已安装的
 * Red Hat VS Code Java 扩展中的 Eclipse JDT Language Server。插件不把数百 MB
 * 的 JDTLS 放进 npm 包；未找到时 Java 仍保留 CodeMirror 语法高亮，只是不启动 LSP。
 */
function findJavaLauncher(): ServerLauncher | null {
  const candidates: string[] = []
  const javaFor = (extensionRoot: string): string => {
    const explicitHome = process.env.DSH_JAVA_HOME
    if (explicitHome !== undefined && explicitHome !== '') {
      return join(explicitHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    }
    const jreRoot = join(extensionRoot, 'jre')
    try {
      const bundled = readdirSync(jreRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(jreRoot, entry.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))
        .find((path) => existsSync(path))
      if (bundled !== undefined) return bundled
    } catch {
      // No embedded JRE; fall back to PATH below.
    }
    const pathHome = process.env.JAVA_HOME
    if (pathHome !== undefined && pathHome !== '') {
      const pathJava = join(pathHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
      if (existsSync(pathJava)) return pathJava
    }
    return 'java'
  }
  const configured = process.env.DSH_JAVA_LS_HOME
  if (configured !== undefined && configured !== '') candidates.push(configured)
  candidates.push(join(homedir(), '.vscode', 'extensions'))
  for (const candidate of candidates) {
    let roots: string[]
    try {
      roots = candidate.endsWith('extensions')
        ? readdirSync(candidate, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('redhat.java-')).map((entry) => join(candidate, entry.name)).sort().reverse()
        : [candidate]
    } catch {
      continue
    }
    for (const extensionRoot of roots) {
      const directConfig = join(extensionRoot, 'config_win')
      const directPlugins = join(extensionRoot, 'plugins')
      const serverRoot = existsSync(directConfig) && existsSync(directPlugins)
        ? extensionRoot
        : extensionRoot.endsWith('server') ? extensionRoot : join(extensionRoot, 'server')
      const config = join(serverRoot, 'config_win')
      const plugins = join(serverRoot, 'plugins')
      if (!existsSync(config) || !existsSync(plugins)) continue
      let launcherEntries
      try {
        launcherEntries = readdirSync(plugins, { withFileTypes: true })
      } catch {
        continue
      }
      const launcher = launcherEntries
        .find((entry) => entry.isFile() && /^org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(entry.name))
      if (launcher === undefined) continue
      const java = javaFor(extensionRoot.endsWith('server') ? extensionRoot.slice(0, -'server'.length) : extensionRoot)
      const launcherJar = join(serverRoot, 'plugins', launcher.name)
      return {
        command: java,
        args: (root) => [
          '-Declipse.application=org.eclipse.jdt.ls.core.id1',
          '-Dosgi.bundles.defaultStartLevel=4',
          '-Declipse.product=org.eclipse.jdt.ls.core.product',
          '-Dlog.protocol=true', '-Dlog.level=ERROR',
          '--add-modules=ALL-SYSTEM',
          '--add-opens', 'java.base/java.util=ALL-UNNAMED',
          '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          '-Xms256m', '-jar', launcherJar,
          '-configuration', config,
          '-data', join(tmpdir(), 'dsh-ide-jdtls', createHash('sha1').update(root).digest('hex').slice(0, 16)),
        ],
      }
    }
  }
  return null
}

/**
 * - ts / py：Node 语言服务器（`process.execPath` 以 Node 模式跑 JS 入口，--stdio）。
 * - ps：PowerShell Editor Services 不是 Node 程序，用 `pwsh` 跑 vendor/ 中的脚本。
 * - java：Eclipse JDT Language Server（可选，见 findJavaLauncher）。
 */
const SERVER_LAUNCHERS: Record<string, ServerLauncher> = (() => {
  const require = createRequire(import.meta.url)
  const tsEntry = require.resolve('typescript-language-server/lib/cli.mjs')
  const pyEntry = require.resolve('pyright/langserver.index.js')
  const psBundle = fileURLToPath(new URL('../vendor', import.meta.url))
  const base: Record<string, ServerLauncher> = {
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
  const java = findJavaLauncher()
  if (java !== null) base.java = java
  return base
})()

/** The server kind for a file path (or null when unsupported). */
export function lspServerForPath(path: string): string | null {
  const language = languageIdForPath(path)
  if (language === null) return null
  if (language === 'python') return 'py'
  if (language === 'powershell') return 'ps'
  if (language === 'java') return 'java'
  return 'ts'
}

/** P1-03：LSP 子进程并发上限 + 单帧大小上限（防资源耗尽）。 */
const LSP_MAX_CONNECTIONS = 8
const LSP_MAX_FRAME_BYTES = 4 * 1024 * 1024
let lspActiveCount = 0

/** Accumulate stdin chunks and split on Content-Length framing.
 *  push 返回 false 表示单帧超过上限（协议违规），调用方应断开连接。 */
export class FrameReader {
  private buffer = Buffer.alloc(0)
  private contentLength: number | null = null
  private readonly maxFrameBytes: number

  constructor(maxFrameBytes = LSP_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes
  }

  push(chunk: Buffer, onMessage: (message: unknown) => void): boolean {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.contentLength === null) {
        const headEnd = this.buffer.indexOf('\r\n\r\n')
        if (headEnd === -1) return true
        const header = this.buffer.subarray(0, headEnd).toString('utf8')
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (match === null) {
          // Malformed header: drop everything up to the next headEnd.
          this.buffer = this.buffer.subarray(headEnd + 4)
          continue
        }
        this.contentLength = Number.parseInt(match[1], 10)
        if (this.contentLength > this.maxFrameBytes) return false
        this.buffer = this.buffer.subarray(headEnd + 4)
      }
      if (this.buffer.length < this.contentLength) return true
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

/** 校验 URI 是否位于授权工作区内：URI 与前缀都先做百分号解码（客户端 pathToUri
 *  会编码空格/#/%/非 ASCII），再做大小写不敏感比较；要求目录段边界（/project
 *  不能匹配 /project2），根自身（/project）放行。 */
export function uriWithinRoot(uri: string, rootUriPrefix: string): boolean {
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const norm = decode(uri).toLowerCase()
  const prefix = decode(rootUriPrefix).toLowerCase()
  return norm === prefix || norm.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

function uriPrefixFor(root: string): string {
  // 与客户端 pathToUri 保持同一编码规则：盘符保留，其余段百分号编码。
  const encoded = root
    .replaceAll('\\', '/')
    .split('/')
    .map((segment, index) => (index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
    .replace(/\/+$/, '')
  return 'file:///' + encoded
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
        ws.close(server === 'java' ? 1011 : 1008, server === 'java'
          ? 'Java LSP unavailable: install JDTLS or set DSH_JAVA_LS_HOME'
          : `unsupported server kind: ${server}`)
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
        child: spawn(launcher.command, launcher.args(gated.canonical), {
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
        const ok = bridge.reader.push(chunk, (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        })
        if (!ok && ws.readyState === WebSocket.OPEN) {
          // 服务器回传帧超过上限：视为协议违规，断开连接并终止子进程。
          closeWs(ws, 1009, 'server frame too large')
          bridge.exited = true
          try { bridge.child.kill() } catch { /* Already gone. */ }
        }
      })
      // P1-03：URI 门禁——LSP 请求中的文件 URI 必须位于授权工作区内，
      // 防止语言服务器读取/索引工作区外的文件（Windows 大小写不敏感）。
      const rootUriPrefix = uriPrefixFor(gated.canonical)
      const uriAllowed = (uri: unknown): boolean => {
        if (typeof uri !== 'string') return true
        return uriWithinRoot(uri, rootUriPrefix)
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
