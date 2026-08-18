/**
 * /dsh-ide/* route layer: JSON envelope (ok/error) for the fs operations and
 * one SSE stream per project root. Services own gating; this layer owns HTTP
 * shape and subscriber bookkeeping. Reference: dsh-web-ui aionui-panel routes
 * (Apache-2.0), trimmed to list/read/write + fs change stream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PanelError } from '../core/types.ts'
import type { FsService } from './fs-service.ts'
import * as git from './git.ts'

const OK = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value })
const FAIL = (error: PanelError): { ok: false; error: PanelError } => ({ ok: false, error })

const BAD_REQUEST: PanelError = { code: 'internal', message: 'malformed request' }

/** Run-a-file limits: per-stream output cap and hard timeout. */
const RUN_OUTPUT_CAP = 200_000
const RUN_TIMEOUT_MS = 60_000

/** The interpreter for a file extension (node uses the host's own binary). */
function runCommandFor(path: string): string[] | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (['js', 'mjs', 'cjs'].includes(ext)) return [process.execPath]
  // node 22.6+ 原生支持 TS（--experimental-strip-types）；老版本会报 unknown option，信息可见
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return [process.execPath, '--experimental-strip-types']
  if (ext === 'py') return ['python']
  if (ext === 'ps1') return ['pwsh', '-File']
  return null
}

/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000

interface Subscriber {
  root: string
  res: ServerResponse
}

/** Loopback trust fence (same judgment dsh-ssh applies to its host routes). */
function isLoopbackRequest(request: IncomingMessage): boolean {
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
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function forbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    chunks.push(buffer)
    total += buffer.length
    if (total > 1 << 20) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function strField(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function strOrEmpty(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function json(res: ServerResponse, envelope: { ok: boolean; value?: unknown; error?: PanelError }, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Path safety for git args: no traversal, no drive letters, relative only. */
function isSafeGitPath(value: string): boolean {
  return !value.includes('..') && !value.startsWith('/') && !value.startsWith('\\') && !value.includes(':')
}

/** Run a git operation against the gated root; errors become PanelError. */
async function withGitRoot(
  fs: FsService,
  root: string,
  run: (cwd: string) => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: PanelError }> {
  const gated = await fs.verify(root)
  if (!gated.ok || gated.canonical === undefined) {
    return { ok: false, error: gated.error ?? { code: 'forbidden', message: 'root not gated' } }
  }
  try {
    return { ok: true, value: await run(gated.canonical) }
  } catch (error) {
    return { ok: false, error: { code: 'git-error', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** A git operation with an optional path arg (shared request shape). */
async function gitWithOptionalPath(
  fs: FsService,
  root: string,
  payload: unknown,
  run: (cwd: string, path: string | undefined) => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: PanelError }> {
  const path = strField(payload, 'path')
  if (path !== null && !isSafeGitPath(path)) {
    return { ok: false, error: { code: 'git-error', message: 'unsafe git path' } }
  }
  return withGitRoot(fs, root, (cwd) => run(cwd, path ?? undefined))
}

/** Register the /dsh-ide routes (prefix for JSON, exact for the SSE stream). */
export function registerPanelRoutes(ctx: Context, fs: FsService): () => void {
  const subscribers = new Set<Subscriber>()
  let heartbeatTimer: NodeJS.Timeout | undefined

  const push = (subscriber: Subscriber, payload: unknown): void => {
    subscriber.res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      json(res, FAIL(BAD_REQUEST), 415)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const payload = await readJsonBody(req)
    if (payload === null) {
      json(res, FAIL(BAD_REQUEST))
      return
    }
    const root = strField(payload, 'root')
    if (root === null) {
      json(res, FAIL(BAD_REQUEST))
      return
    }
    switch (pathname) {
      case '/dsh-ide/list': {
        const path = strField(payload, 'path') ?? ''
        const result = await fs.list(root, path)
        json(res, 'entries' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/read': {
        const path = strField(payload, 'path')
        if (path === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await fs.read(root, path)
        json(res, 'content' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/write': {
        const path = strField(payload, 'path')
        const content = strOrEmpty(payload, 'content')
        if (path === null || content === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const rawBase = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).baseMtime
          : undefined
        const baseMtime = typeof rawBase === 'number' && Number.isFinite(rawBase) ? rawBase : undefined
        const result = await fs.write(root, path, content, baseMtime)
        json(res, 'mtime' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/mkdir': {
        const path = strField(payload, 'path')
        if (path === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await fs.createDir(root, path)
        json(res, 'ok' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/rename': {
        const from = strField(payload, 'from')
        const to = strField(payload, 'to')
        if (from === null || to === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await fs.rename(root, from, to)
        json(res, 'ok' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/remove': {
        const path = strField(payload, 'path')
        if (path === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await fs.remove(root, path)
        json(res, 'ok' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/reveal': {
        const path = strField(payload, 'path') ?? ''
        const result = await fs.resolve(root, path)
        if (!('abs' in result)) {
          json(res, FAIL(result))
          return
        }
        try {
          // Windows Explorer 定位到文件（/select, 前缀，路径带逗号也能处理）。
          spawn('explorer.exe', [`/select,${result.abs}`], { detached: true, stdio: 'ignore' }).unref()
        } catch {
          json(res, FAIL({ code: 'internal', message: 'cannot open explorer' }))
          return
        }
        json(res, OK({ ok: true }))
        return
      }
      case '/dsh-ide/run': {
        const path = strField(payload, 'path')
        if (path === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const resolved = await fs.resolve(root, path)
        if (!('abs' in resolved)) {
          json(res, FAIL(resolved))
          return
        }
        const command = runCommandFor(path)
        if (command === null) {
          json(res, FAIL({ code: 'unsupported', message: `不支持运行 .${(path.split('.').pop() ?? '')} 文件（支持 js/ts/py/ps1）` }))
          return
        }
        const start = Date.now()
        let timedOut = false
        let stdout = ''
        let stderr = ''
        let stdoutTruncated = false
        let stderrTruncated = false
        const appendChunk = (target: 'out' | 'err', chunk: Buffer): void => {
          const bucket = target === 'out' ? stdout : stderr
          if (bucket.length >= RUN_OUTPUT_CAP) return
          const text = chunk.toString('utf8')
          if (target === 'out') stdout += text
          else stderr += text
          const current = target === 'out' ? stdout : stderr
          if (current.length > RUN_OUTPUT_CAP) {
            if (target === 'out') { stdout = current.slice(0, RUN_OUTPUT_CAP); stdoutTruncated = true }
            else { stderr = current.slice(0, RUN_OUTPUT_CAP); stderrTruncated = true }
          }
        }
        const child = spawn(command[0], [...command.slice(1), resolved.abs], {
          cwd: dirname(resolved.abs),
          // DSH Desktop 是 Electron 宿主：process.execPath 指向 DSH Desktop.exe，
          // 不加 ELECTRON_RUN_AS_NODE 会以 Electron GUI 模式启动脚本 → 立即退出。
          // 该变量让 exe 以 Node 模式运行（对普通 Node 宿主无害）。
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        })
        child.stdout?.on('data', (chunk: Buffer) => appendChunk('out', chunk))
        child.stderr?.on('data', (chunk: Buffer) => appendChunk('err', chunk))
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, RUN_TIMEOUT_MS)
        const settled = await new Promise<{ error?: string; code?: number | null; signal?: string | null }>((done) => {
          child.on('error', (error) => done({ error: error.message }))
          child.on('close', (code, signal) => done({ code, signal }))
        })
        clearTimeout(timer)
        if (settled.error !== undefined) {
          json(res, FAIL({ code: 'spawn-failed', message: `无法启动解释器: ${settled.error}` }))
          return
        }
        json(res, OK({
          exitCode: settled.code ?? null,
          signal: settled.signal ?? null,
          timedOut,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - start,
        }))
        return
      }
      case '/dsh-ide/git/status': {
        const result = await withGitRoot(fs, root, (cwd) => git.status(cwd))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/repos': {
        // Discover git repos below the gated root (root itself included) so the
        // panel can offer nested repos when the workspace root is not one.
        const result = await withGitRoot(fs, root, async (cwd) => {
          const repos = await git.findRepos(cwd)
          return Promise.all(repos.map(async (repo) => ({
            path: repo,
            name: repo === cwd ? repo : repo.slice(cwd.length + 1).replaceAll('\\', '/'),
            branch: await git.currentBranch(repo).catch(() => 'HEAD'),
          })))
        })
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/diff': {
        const staged = strField(payload, 'staged') === 'true'
        const result = await gitWithOptionalPath(fs, root, payload, (cwd, path) => git.diff(cwd, path, staged))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/stage': {
        const result = await gitWithOptionalPath(fs, root, payload, (cwd, path) => git.stage(cwd, path).then(() => ({ ok: true })))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/unstage': {
        const result = await gitWithOptionalPath(fs, root, payload, (cwd, path) => git.unstage(cwd, path).then(() => ({ ok: true })))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/discard': {
        const result = await gitWithOptionalPath(fs, root, payload, (cwd, path) => {
          if (path === undefined) return Promise.reject(new Error('discard requires a path'))
          return git.discard(cwd, path).then(() => ({ ok: true }))
        })
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/commit': {
        const message = strField(payload, 'message')
        if (message === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await withGitRoot(fs, root, (cwd) => git.commit(cwd, message).then(() => ({ ok: true })))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/log': {
        const rawCount = strField(payload, 'count')
        const count = rawCount === null ? 30 : Number.parseInt(rawCount, 10)
        const result = await withGitRoot(fs, root, (cwd) => git.log(cwd, Number.isFinite(count) ? count : 30))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      case '/dsh-ide/git/commit-diff': {
        const hash = strField(payload, 'hash')
        if (hash === null || !/^[0-9a-fA-F]{4,40}$/.test(hash)) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await withGitRoot(fs, root, (cwd) => git.commitDiff(cwd, hash))
        json(res, result.ok ? OK(result.value) : FAIL(result.error))
        return
      }
      default:
        res.writeHead(404)
        res.end()
    }
  }

  const sse = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      forbidden(res)
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const root = url.searchParams.get('root')
    if (root === null || root === '') {
      res.writeHead(400)
      res.end()
      return
    }
    const gated = await fs.verify(root)
    if (!gated.ok || gated.canonical === undefined) {
      json(res, FAIL(gated.error ?? { code: 'forbidden', message: 'root not gated' }), 400)
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    const subscriber: Subscriber = { root: gated.canonical, res }
    subscribers.add(subscriber)
    if (heartbeatTimer === undefined) {
      heartbeatTimer = setInterval(() => {
        for (const current of subscribers) current.res.write(': ping\n\n')
      }, HEARTBEAT_MS)
    }
    const disposeWatch = fs.watch(gated.canonical, () => {
      push(subscriber, { kind: 'fs', root: gated.canonical })
    })
    req.on('close', () => {
      disposeWatch()
      subscribers.delete(subscriber)
      if (subscribers.size === 0 && heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/dsh-ide', handler }),
    ctx.webServer.register({ kind: 'exact', path: '/dsh-ide/events', handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    for (const subscriber of subscribers) subscriber.res.end()
    subscribers.clear()
  }
}
