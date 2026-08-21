/**
 * /dsh-ide/* route layer: JSON envelope (ok/error) for the fs operations and
 * one SSE stream per project root. Services own gating; this layer owns HTTP
 * shape and subscriber bookkeeping. Reference: dsh-web-ui aionui-panel routes
 * (Apache-2.0), trimmed to list/read/write + fs change stream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PanelError } from '../core/types.ts'
import { isTextEncodingId } from '../core/encoding.ts'
import type { FsService } from './fs-service.ts'
import * as git from './git.ts'
import { isLoopbackRequest } from './security.ts'

const OK = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value })
const FAIL = (error: PanelError): { ok: false; error: PanelError } => ({ ok: false, error })

const BAD_REQUEST: PanelError = { code: 'internal', message: 'malformed request' }

/** Run-a-file limits: per-stream output cap and hard timeout. */
const RUN_OUTPUT_CAP = 200_000
const RUN_TIMEOUT_MS = 60_000
/** P1-02：运行进程并发上限（防批量拉起子进程耗尽资源）。 */
const RUN_MAX_CONCURRENT = 3
let runActiveCount = 0

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

interface ProcessResult {
  error?: string
  code?: number | null
  signal?: string | null
  timedOut: boolean
}

/** 在宿主侧执行一个受限子进程；Java 编译和运行共用同一套超时/输出上限。 */
function runProcess(
  command: string,
  args: string[],
  cwd: string,
  appendChunk: (target: 'out' | 'err', chunk: Buffer) => void,
): Promise<ProcessResult> {
  return new Promise((done) => {
    let timedOut = false
    let settled = false
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk: Buffer) => appendChunk('out', chunk))
    child.stderr?.on('data', (chunk: Buffer) => appendChunk('err', chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)
    const finish = (result: Omit<ProcessResult, 'timedOut'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ ...result, timedOut })
    }
    child.on('error', (error) => finish({ error: error.message }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

/** Java 单文件入口：只支持一个源文件，编译产物写入系统临时目录，不污染工作区。 */
async function javaSingleFileCommand(abs: string): Promise<{
  outputDir: string
  mainClass: string
} | { error: string }> {
  let source: string
  try {
    source = await readFile(abs, 'utf8')
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const packageMatch = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m.exec(source)
  const className = basename(abs).replace(/\.java$/i, '')
  const packageName = packageMatch?.[1]
  const outputDir = await mkdtemp(join(tmpdir(), 'dsh-ide-java-'))
  return { outputDir, mainClass: packageName === undefined ? className : `${packageName}.${className}` }
}

/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000

interface Subscriber {
  root: string
  res: ServerResponse
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

/**
 * Run a git operation against the gated root; errors become PanelError.
 * P0-03: git resolves the repo upward from any subdirectory, so unless
 * `allowSubdirRoot` is set (status probe), the requested root must itself be
 * the canonical repository top level. Otherwise the operation is refused —
 * it could touch files in a parent repo outside the selected root.
 */
async function withGitRoot(
  fs: FsService,
  root: string,
  run: (cwd: string) => Promise<unknown>,
  opts: { allowSubdirRoot?: boolean } = {},
): Promise<{ ok: true; value: unknown } | { ok: false; error: PanelError }> {
  const gated = await fs.verify(root)
  if (!gated.ok || gated.canonical === undefined) {
    return { ok: false, error: gated.error ?? { code: 'forbidden', message: 'root not gated' } }
  }
  if (!opts.allowSubdirRoot) {
    const top = await git.repoTopLevel(gated.canonical)
    if (top !== null && top !== gated.canonical) {
      return {
        ok: false,
        error: {
          code: 'git-root-outside',
          message: '所选目录位于父 Git 仓库内，请在 Git 面板中选择该仓库根目录',
        },
      }
    }
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
        const encodingRaw = strOrEmpty(payload, 'encoding') ?? 'utf-8'
        if (encodingRaw !== 'auto' && !isTextEncodingId(encodingRaw)) {
          json(res, FAIL({ code: 'encoding-unsupported', message: `不支持的编码: ${encodingRaw}` }))
          return
        }
        const result = await fs.read(root, path, encodingRaw)
        json(res, 'content' in result ? OK(result) : FAIL(result))
        return
      }
      case '/dsh-ide/read-binary': {
        const path = strField(payload, 'path')
        if (path === null) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const result = await fs.readBinary(root, path)
        json(res, 'data' in result ? OK(result) : FAIL(result))
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
        const encodingRaw = strOrEmpty(payload, 'encoding') ?? 'utf-8'
        if (!isTextEncodingId(encodingRaw)) {
          json(res, FAIL({ code: 'encoding-unsupported', message: `不支持的编码: ${encodingRaw}` }))
          return
        }
        const result = await fs.write(root, path, content, baseMtime, encodingRaw)
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
        const isJava = (path.split('.').pop() ?? '').toLowerCase() === 'java'
        const command = runCommandFor(path)
        if (command === null && !isJava) {
          json(res, FAIL({ code: 'unsupported', message: `不支持运行 .${(path.split('.').pop() ?? '')} 文件（支持 js/ts/py/ps1/java）` }))
          return
        }
        // P1-02：并发上限——同时运行太多脚本会耗尽宿主资源。
        if (runActiveCount >= RUN_MAX_CONCURRENT) {
          json(res, FAIL({ code: 'run-busy', message: `同时运行的任务已达上限（${RUN_MAX_CONCURRENT} 个），请稍后再试` }))
          return
        }
        runActiveCount += 1
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
        let settled: ProcessResult = { timedOut: false }
        let javaOutputDir: string | undefined
        if (isJava) {
          const java = await javaSingleFileCommand(resolved.abs)
          if ('error' in java) {
            runActiveCount = Math.max(0, runActiveCount - 1)
            json(res, FAIL({ code: 'java-prepare-failed', message: `无法准备 Java 文件: ${java.error}` }))
            return
          }
          javaOutputDir = java.outputDir
          const compile = await runProcess('javac', ['-encoding', 'UTF-8', '-d', java.outputDir, resolved.abs], dirname(resolved.abs), appendChunk)
          if (compile.error !== undefined || compile.code !== 0 || compile.signal !== null || compile.timedOut) {
            settled = compile
            timedOut = compile.timedOut
          } else {
            settled = await runProcess('java', [
              '-Dfile.encoding=UTF-8',
              '-Dsun.stdout.encoding=UTF-8',
              '-Dsun.stderr.encoding=UTF-8',
              '-cp', java.outputDir, java.mainClass,
            ], dirname(resolved.abs), appendChunk)
            timedOut = settled.timedOut
          }
        } else if (command !== null) {
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
          settled = await new Promise<ProcessResult>((done) => {
            child.on('error', (error) => done({ error: error.message, timedOut }))
            child.on('close', (code, signal) => done({ code, signal, timedOut }))
          })
          clearTimeout(timer)
        }
        if (javaOutputDir !== undefined) {
          try {
            await rm(javaOutputDir, { recursive: true, force: true })
          } catch {
            // 临时目录清理失败不影响运行结果。
          }
        }
        runActiveCount = Math.max(0, runActiveCount - 1)
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
        // status 是只读探测：root 非仓库（含父仓库子目录）时返回 isRepo:false，
        // 由前端发现嵌套仓库；写操作（stage/commit 等）仍受 withGitRoot 严格校验。
        const result = await withGitRoot(fs, root, (cwd) => git.status(cwd), { allowSubdirRoot: true })
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
      case '/dsh-ide/git/blame': {
        const path = strField(payload, 'path')
        if (path === null || !isSafeGitPath(path)) {
          json(res, FAIL(BAD_REQUEST))
          return
        }
        const gated = await fs.verify(root)
        if (!gated.ok || gated.canonical === undefined) {
          json(res, FAIL(gated.error ?? { code: 'forbidden', message: 'root not gated' }))
          return
        }
        // 先解析文件绝对路径：blame 是编辑器功能（无仓库选择器），当工作区
        // root 只是父目录、文件属于嵌套子仓库时（如多插件工作区 E:\dsh-plugins
        // 下的各插件），git -C <root> 找不到仓库——自动从文件向上找最近仓库根。
        const resolved = await fs.resolve(root, path)
        if (!('abs' in resolved)) {
          json(res, FAIL(resolved))
          return
        }
        let cwd = gated.canonical
        let relPath = path
        if (!(await git.isGitRepo(cwd))) {
          const repo = await git.findRepoRootForFile(resolved.abs)
          if (repo === null) {
            // 不在任何仓库内（未跟踪新文件 / 非仓库目录）：无 blame，不算错误。
            json(res, OK({ path, lines: [] }))
            return
          }
          cwd = repo
          relPath = relative(cwd, resolved.abs).replaceAll('\\', '/')
        }
        try {
          const lines = await git.blame(cwd, relPath)
          json(res, OK({ path, lines }))
        } catch (error) {
          json(res, FAIL({ code: 'git-error', message: error instanceof Error ? error.message : String(error) }))
        }
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
