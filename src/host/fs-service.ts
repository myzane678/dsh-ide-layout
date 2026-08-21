/**
 * Host filesystem service for the IDE layout: directory listing, file read
 * (utf-8, capped), text write with mtime conflict check, and a recursive
 * watcher emitting change events. Every operation resolves against a
 * workspace-gated project root and refuses to escape it (path traversal
 * guard). Reference: dsh-web-ui aionui-panel fs-service (Apache-2.0),
 * re-implemented and trimmed to the IDE-layout scope.
 */

import { mkdir, readdir, readFile, realpath, rename as renameFs, rm, stat, writeFile } from 'node:fs/promises'
import { watch as watchPath, type Dirent, type FSWatcher } from 'node:fs'
import { join, dirname } from 'node:path'
import type { DirListing, FileRead, FileReadBinary, FsEntry, PanelError } from '../core/types.ts'
import { isTextEncodingId, type TextEncodingId } from '../core/encoding.ts'
import { imageMimeForPath, IMAGE_CAP_BYTES } from '../core/media.ts'
import { decodeText, encodeText } from './encoding.ts'

/** Text read ceiling for the editor. */
const TEXT_CAP_CHARS = 500_000
/** Directories never listed in the tree. */
const TREE_SKIP_DIRS = new Set(['.git'])
/** Polling fallback interval when recursive watch is unavailable. */
const POLL_FALLBACK_MS = 3_000

/** True when the relative path is, or passes through, a .git component. */
function isGitPath(rel: string): boolean {
  return rel.split('/').some((part) => part.toLowerCase() === '.git')
}

/** Case-insensitive alpha compare (dirs first, then files). */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  return an < bn ? -1 : an > bn ? 1 : 0
}

/** Workspace membership verdict. */
export interface GateVerdict {
  ok: boolean
  canonical?: string
  error?: PanelError
}

/** The gate: root must be a registered workspace (or inside one). */
export type WorkspaceGate = (root: string) => Promise<GateVerdict>

/**
 * Resolve a relative path against the canonical root, realpath-checking the
 * existing ancestors so a symlink cannot smuggle the operation outside the
 * root.
 */
async function resolveInsideRoot(root: string, rel: string): Promise<{ ok: true; abs: string } | { ok: false; error: PanelError }> {
  if (rel.includes('\0')) return { ok: false, error: { code: 'path-outside-root', message: 'invalid path' } }
  const abs = join(root, rel)
  if (!isPathInside(root, abs)) {
    return { ok: false, error: { code: 'path-outside-root', message: `path escapes root: ${rel}` } }
  }
  let probe = abs
  for (let hop = 0; hop < 32; hop += 1) {
    let real: string
    try {
      real = await realpath(probe)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return { ok: true, abs }
      const parent = dirname(probe)
      if (parent === probe) return { ok: true, abs }
      probe = parent
      continue
    }
    if (!isPathInside(root, real)) {
      return { ok: false, error: { code: 'path-outside-root', message: `path resolves outside root: ${rel}` } }
    }
    return { ok: true, abs }
  }
  return { ok: false, error: { code: 'path-outside-root', message: `path cannot be resolved: ${rel}` } }
}

/** Platform-correct containment check (win32 is case-insensitive). */
function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedTarget = target
  const rootLower = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  const targetLower = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget
  const sep = process.platform === 'win32' ? '\\' : '/'
  return targetLower === rootLower || targetLower.startsWith(rootLower + sep)
}

/** True when the changed path lives inside a noise directory (watch noise).
 *  node_modules/.git 之外，DSH 数据目录（sessions/logs/attachments）与任何
 *  隐藏目录（. 开头）变化频繁且用户基本不关心——只影响「变更事件」，不影响文件树显示。 */
function isIgnoredWatchPath(filename: string): boolean {
  return filename.split(/[\\/]/).some((part) => {
    const candidate = process.platform === 'win32' ? part.toLowerCase() : part
    return candidate === 'node_modules'
      || candidate === '.git'
      || candidate === 'sessions'
      || candidate === 'logs'
      || candidate === 'attachments'
      || (candidate.startsWith('.') && candidate !== '.' && candidate !== '..')
  })
}

/** The fs.watch call shape the service needs (constructor seam for tests). */
export type SpawnWatcher = (
  path: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

const defaultSpawnWatcher: SpawnWatcher = (path, options, listener) => watchPath(path, options, listener)

/**
 * P1-01（TOCTOU 缓解）：操作前对目标最近已存在祖先做二次 realpath 校验。
 * 若祖先目录在首次检查后被替换为 symlink/reparse point，二次校验能发现
 * 它解析到 root 外并拒绝。注意这只能缩小窗口，无法完全消除竞态——
 * 不声称完全防护（审查要求的边界说明）。
 */
async function reverifyAncestors(root: string, abs: string): Promise<PanelError | null> {
  let probe = abs
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!isPathInside(root, real)) {
        return { code: 'path-outside-root', message: 'path resolves outside root (symlink/reparse detected)' }
      }
      return null
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
  }
}

/** Filesystem service: gated listing/read/write plus a change watcher. */
export class FsService {
  constructor(
    private readonly gate: WorkspaceGate,
    private readonly spawnWatcher: SpawnWatcher = defaultSpawnWatcher,
  ) {}

  verify(root: string): Promise<GateVerdict> {
    return this.gate(root)
  }

  /** List one directory (relative path; '' = root). Sorted dirs-first alpha. */
  async list(root: string, rel: string): Promise<DirListing | PanelError> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    let dirents: Dirent[]
    try {
      dirents = await readdir(resolved.abs, { withFileTypes: true })
    } catch {
      return { code: 'not-found', message: `cannot list ${rel}` }
    }
    const out: FsEntry[] = []
    for (const entry of dirents) {
      if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        out.push({ name: entry.name, path, isDir: true, size: 0, mtime: 0 })
      }
    }
    const files = dirents.filter((entry) => !entry.isDirectory())
    const statted = await Promise.all(files.map(async (entry) => {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      try {
        const info = await stat(join(resolved.abs, entry.name))
        return { name: entry.name, path, isDir: false, size: info.size, mtime: info.mtimeMs }
      } catch {
        return { name: entry.name, path, isDir: false, size: 0, mtime: 0 }
      }
    }))
    out.push(...statted)
    out.sort(compareEntries)
    return { root: gated.canonical, entries: out }
  }

  /**
   * Read one file as text (capped), decoding with the requested encoding.
   * `encoding` may be 'auto'（先检测再解码，返回实际使用的编码）或白名单编码。
   */
  async read(root: string, rel: string, encoding: TextEncodingId | 'auto' = 'utf-8'): Promise<FileRead | PanelError> {
    if (encoding !== 'auto' && !isTextEncodingId(encoding)) {
      return { code: 'encoding-unsupported', message: `不支持的编码: ${encoding}` }
    }
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    let data: Buffer
    let info: Awaited<ReturnType<typeof stat>>
    try {
      data = await readFile(resolved.abs)
      info = await stat(resolved.abs)
    } catch {
      return { code: 'not-found', message: `cannot read ${rel}` }
    }
    if (info.isDirectory()) return { code: 'is-directory', message: `${rel} is a directory` }
    const { text, encoding: used } = decodeText(data, encoding)
    const truncated = text.length > TEXT_CAP_CHARS
    return {
      content: truncated ? text.slice(0, TEXT_CAP_CHARS) : text,
      truncated,
      size: data.length,
      mtime: info.mtimeMs,
      encoding: used,
    }
  }

  /** Read an image file as base64 + MIME（编辑器图片预览；扩展名白名单限定）。 */
  async readBinary(root: string, rel: string): Promise<FileReadBinary | PanelError> {
    const mime = imageMimeForPath(rel)
    if (mime === null) {
      return { code: 'unsupported-media', message: `不是可预览的图片类型: ${rel}` }
    }
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    let data: Buffer
    let info: Awaited<ReturnType<typeof stat>>
    try {
      data = await readFile(resolved.abs)
      info = await stat(resolved.abs)
    } catch {
      return { code: 'not-found', message: `cannot read ${rel}` }
    }
    if (info.isDirectory()) return { code: 'is-directory', message: `${rel} is a directory` }
    if (data.length > IMAGE_CAP_BYTES) {
      return { code: 'file-too-large', message: `图片超过 ${Math.round(IMAGE_CAP_BYTES / 1024 / 1024)}MB，无法预览` }
    }
    return { data: data.toString('base64'), mime, size: data.length, mtime: info.mtimeMs }
  }

  /** Write text content back, refusing when the file moved on disk. */
  async write(
    root: string,
    rel: string,
    content: string,
    baseMtime?: number,
    encoding: TextEncodingId = 'utf-8',
  ): Promise<{ mtime: number } | PanelError> {
    if (!isTextEncodingId(encoding)) {
      return { code: 'encoding-unsupported', message: `不支持的编码: ${encoding}` }
    }
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    if (isGitPath(rel)) return { code: 'path-outside-root', message: 'refusing to touch .git' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    // P1-01：写前二次 canonical 校验（防祖先目录被换为 symlink）。
    const reverify = await reverifyAncestors(gated.canonical, resolved.abs)
    if (reverify !== null) return reverify
    try {
      let current: Awaited<ReturnType<typeof stat>>
      try {
        current = await stat(resolved.abs)
      } catch {
        current = { mtimeMs: 0 } as Awaited<ReturnType<typeof stat>>
      }
      if (baseMtime !== undefined && Number(current.mtimeMs) !== 0 && Math.abs(Number(current.mtimeMs) - baseMtime) > 1) {
        return { code: 'write-conflict', message: 'file changed on disk since it was loaded' }
      }
      await mkdir(dirname(resolved.abs), { recursive: true })
      await writeFile(resolved.abs, encodeText(content, encoding))
      const info = await stat(resolved.abs)
      return { mtime: info.mtimeMs }
    } catch {
      return { code: 'write-failed', message: `cannot write ${rel}` }
    }
  }

  /** Create a directory (recursive, refuses .git and escapes). */
  async createDir(root: string, rel: string): Promise<{ ok: true } | PanelError> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    if (isGitPath(rel)) return { code: 'path-outside-root', message: 'refusing to touch .git' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    try {
      await mkdir(resolved.abs, { recursive: true })
      return { ok: true }
    } catch {
      return { code: 'write-failed', message: `cannot create directory ${rel}` }
    }
  }

  /** Rename or move a path inside the root (refuses .git and escapes). */
  async rename(root: string, from: string, to: string): Promise<{ ok: true } | PanelError> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    if (isGitPath(from) || isGitPath(to)) return { code: 'path-outside-root', message: 'refusing to touch .git' }
    const source = await resolveInsideRoot(gated.canonical, from)
    if (!source.ok) return source.error
    const target = await resolveInsideRoot(gated.canonical, to)
    if (!target.ok) return target.error
    // P1-01：改名前后两端二次 canonical 校验。
    const sourceRecheck = await reverifyAncestors(gated.canonical, source.abs)
    if (sourceRecheck !== null) return sourceRecheck
    const targetRecheck = await reverifyAncestors(gated.canonical, target.abs)
    if (targetRecheck !== null) return targetRecheck
    try {
      await renameFs(source.abs, target.abs)
      return { ok: true }
    } catch {
      return { code: 'write-failed', message: `cannot rename ${from}` }
    }
  }

  /** Remove a file or a directory tree (refuses .git and the workspace root). */
  async remove(root: string, rel: string): Promise<{ ok: true } | PanelError> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    if (isGitPath(rel)) return { code: 'path-outside-root', message: 'refusing to touch .git' }
    if (rel === '') return { code: 'path-outside-root', message: 'refusing to remove the workspace root' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    // P1-01：删除前二次 canonical 校验。
    const reverify = await reverifyAncestors(gated.canonical, resolved.abs)
    if (reverify !== null) return reverify
    try {
      await rm(resolved.abs, { recursive: true, force: false })
      return { ok: true }
    } catch {
      return { code: 'write-failed', message: `cannot remove ${rel}` }
    }
  }

  /** Resolve a gated absolute path (for host-side shell actions like reveal). */
  async resolve(root: string, rel: string): Promise<{ ok: true; abs: string } | PanelError> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return gated.error ?? { code: 'forbidden', message: 'root not gated' }
    const resolved = await resolveInsideRoot(gated.canonical, rel)
    if (!resolved.ok) return resolved.error
    return { ok: true, abs: resolved.abs }
  }

  /**
   * Watch a root recursively and emit change events (debounced + batched).
   * @param root - project root to watch (gated on connect).
   * @param onChange - fired (debounced) when anything under root changed.
   * @returns disposer.
   */
  watch(root: string, onChange: () => void): () => void {
    let disposed = false
    let timer: NodeJS.Timeout | undefined
    let pollTimer: NodeJS.Timeout | undefined
    let watcher: FSWatcher | undefined
    const fire = (): void => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed) onChange()
      }, 150)
    }
    let lastSignature = ''
    const poll = (): void => {
      void this.signature(root).then((signature) => {
        if (signature === null || signature === lastSignature) return
        lastSignature = signature
        fire()
      })
    }
    const startPolling = (): void => {
      if (pollTimer !== undefined) return
      poll()
      pollTimer = setInterval(poll, POLL_FALLBACK_MS)
    }
    void this.gate(root).then((gated) => {
      if (!gated.ok || disposed || gated.canonical === undefined) return
      try {
        watcher = this.spawnWatcher(gated.canonical, { recursive: true }, (_event, filename) => {
          const name = filename === null
            ? null
            : Buffer.isBuffer(filename) ? filename.toString('utf8') : filename
          if (name !== null && isIgnoredWatchPath(name)) return
          fire()
        })
        watcher.on('error', () => {
          if (disposed) return
          watcher?.close()
          watcher = undefined
          startPolling()
        })
      } catch {
        watcher = undefined
        startPolling()
      }
    })
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      if (pollTimer !== undefined) clearInterval(pollTimer)
      watcher?.close()
    }
  }

  /** Cheap root signature: entries of the root with sizes/mtimes (poll fallback). */
  private async signature(root: string): Promise<string | null> {
    const gated = await this.gate(root)
    if (!gated.ok || gated.canonical === undefined) return null
    try {
      const entries: Dirent[] = await readdir(gated.canonical, { withFileTypes: true })
      const parts: string[] = []
      for (const entry of entries.slice(0, 200)) {
        let extra = ''
        if (!entry.isDirectory()) {
          try {
            const info = await stat(join(gated.canonical, entry.name))
            extra = `${info.size}:${Math.round(info.mtimeMs / 1000)}`
          } catch {
            extra = 'gone'
          }
        }
        parts.push(`${entry.name}${entry.isDirectory() ? '/' : ''}${extra}`)
      }
      return parts.join('|')
    } catch {
      return null
    }
  }
}
