/** Browser-side fetch wrapper for the /dsh-ide host routes. */

import type { DirListing, FileRead, PanelError } from '../core/types.ts'

export type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: PanelError }

async function post<T>(path: string, body: unknown): Promise<Envelope<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let error: PanelError = { code: 'http', message: `HTTP ${response.status}` }
    try {
      const parsed = await response.json() as { error?: PanelError }
      if (parsed.error !== undefined) error = parsed.error
    } catch {
      // keep the http fallback
    }
    return { ok: false, error }
  }
  return await response.json() as Envelope<T>
}

export function apiList(root: string, path: string): Promise<Envelope<DirListing>> {
  return post<DirListing>('/dsh-ide/list', { root, path })
}

export function apiRead(root: string, path: string): Promise<Envelope<FileRead>> {
  return post<FileRead>('/dsh-ide/read', { root, path })
}

export function apiWrite(root: string, path: string, content: string, baseMtime?: number): Promise<Envelope<{ mtime: number }>> {
  return post<{ mtime: number }>('/dsh-ide/write', { root, path, content, baseMtime })
}

export function apiCreateDir(root: string, path: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/mkdir', { root, path })
}

export function apiRename(root: string, from: string, to: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/rename', { root, from, to })
}

export function apiRemove(root: string, path: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/remove', { root, path })
}

export function apiReveal(root: string, path: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/reveal', { root, path })
}

/** One run of a file: captured stdout/stderr, exit code, timing. */
export interface RunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
}

export function apiRun(root: string, path: string): Promise<Envelope<RunResult>> {
  return post<RunResult>('/dsh-ide/run', { root, path })
}

/** git 面板数据与操作（与 host 侧 git.ts 对应）。 */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
}

export interface GitLogEntry {
  hash: string
  hashFull: string
  subject: string
  author: string
  date: string
  refs: string
}

export function apiGitStatus(root: string): Promise<Envelope<GitStatusResult>> {
  return post<GitStatusResult>('/dsh-ide/git/status', { root })
}

export function apiGitDiff(root: string, path: string | undefined, staged: boolean): Promise<Envelope<string>> {
  return post<string>('/dsh-ide/git/diff', { root, path: path ?? '', staged: staged ? 'true' : 'false' })
}

export function apiGitStage(root: string, path: string | undefined): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/git/stage', { root, path: path ?? '' })
}

export function apiGitUnstage(root: string, path: string | undefined): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/git/unstage', { root, path: path ?? '' })
}

export function apiGitDiscard(root: string, path: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/git/discard', { root, path })
}

export function apiGitCommit(root: string, message: string): Promise<Envelope<{ ok: true }>> {
  return post<{ ok: true }>('/dsh-ide/git/commit', { root, message })
}

export function apiGitLog(root: string, count?: number): Promise<Envelope<GitLogEntry[]>> {
  return post<GitLogEntry[]>('/dsh-ide/git/log', { root, count: count === undefined ? '' : String(count) })
}

export function apiGitCommitDiff(root: string, hash: string): Promise<Envelope<string>> {
  return post<string>('/dsh-ide/git/commit-diff', { root, hash })
}

/** Subscribe to fs change events for one root (SSE). Returns a disposer. */
export function subscribeChanges(root: string, onChange: () => void): () => void {
  const source = new EventSource(`/dsh-ide/events?root=${encodeURIComponent(root)}`)
  const handler = (event: MessageEvent): void => {
    try {
      const payload = JSON.parse(event.data as string) as { kind: string }
      if (payload.kind === 'fs') onChange()
    } catch {
      // ignore malformed events
    }
  }
  source.addEventListener('change', handler)
  return () => source.close()
}
