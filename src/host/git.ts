/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` so output stays machine-readable.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { spawn } from 'node:child_process'
import { readdir, stat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
}

/** One `git log` row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations: revert / cherry-pick). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`), e.g. `2024-01-01 10:00:00 +0800`. */
  date: string
  /** Ref decorations (`%D` with --decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code = 'git-error',
    readonly command: string,
  ) {
    super(message)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
    })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'git-error', args.join(' ')))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, 'git-error', args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, 'git-error', args.join(' ')))
      }
    })
  })
}

/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Discover git repositories below `root` (the workspace root itself included).
 * Walk the directory tree, skipping node_modules / hidden dirs / .git internals,
 * and collect every directory that contains a `.git` entry (dir or worktree
 * file). Used by the git panel to offer nested repos when the workspace root
 * itself is not a repo. Depth is bounded so huge trees stay cheap.
 */
export async function findRepos(root: string, maxDepth = 5): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || seen.has(dir)) return
    seen.add(dir)
    try {
      await stat(join(dir, '.git'))
      found.push(dir)
      // A repo boundary: don't descend into its submodules/worktrees.
      return
    } catch {
      // not a repo, keep walking
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (name === 'node_modules' || name.startsWith('.')) continue
      await walk(join(dir, name), depth + 1)
    }
  }
  await walk(root, 1)
  return found
}

/**
 * Find the nearest git repository root containing a file, walking upward from
 * the file's directory. Used by blame when the workspace root is only a parent
 * directory (e.g. a multi-repo workspace) — the file belongs to a nested repo
 * that `git -C <root>` cannot see. Returns null when no ancestor has `.git`.
 */
export async function findRepoRootForFile(absPath: string): Promise<string | null> {
  let dir = dirname(absPath)
  for (;;) {
    try {
      await stat(join(dir, '.git'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
export async function repoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return out.trim()
}

/**
 * Canonical (realpath'd) repository root containing `cwd`, or null when `cwd`
 * is not inside any git repo. Used for P0-03: git resolves the repo upward
 * from any subdirectory, so we must verify that a requested root IS the repo
 * top level before running commands that could touch the parent repo.
 */
export async function repoTopLevel(cwd: string): Promise<string | null> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    const top = out.trim()
    if (top === '') return null
    return await realpath(top)
  } catch {
    return null
  }
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/** Working-tree status (untracked included). */
export async function status(cwd: string): Promise<GitStatusResult> {
  const repo = await isGitRepo(cwd)
  if (!repo) return { isRepo: false, entries: [] }
  const [branch, raw] = await Promise.all([
    currentBranch(cwd).catch(() => 'HEAD'),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ])
  return { isRepo: true, branch, entries: parsePorcelainZ(raw) }
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function diff(cwd: string, path: string | undefined, staged: boolean): Promise<string> {
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(cwd, args)
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined): Promise<void> {
  await runGit(cwd, ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined): Promise<void> {
  await runGit(cwd, ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string): Promise<void> {
  await runGit(cwd, ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string): Promise<{ current: string; names: string[] }> {
  const [current, raw] = await Promise.all([
    currentBranch(cwd).catch(() => 'HEAD'),
    runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string): Promise<void> {
  await runGit(cwd, ['checkout', branch])
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(cwd: string, count = 30, skip = 0): Promise<GitLogEntry[]> {
  const raw = await runGit(cwd, [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 */
export async function show(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    return await runGit(cwd, ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content. */
export async function commitDiff(cwd: string, hash: string): Promise<string> {
  return runGit(cwd, ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string): Promise<void> {
  await runGit(cwd, ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message. */
export async function revert(cwd: string, hash: string): Promise<void> {
  await runGit(cwd, ['revert', '--no-edit', hash])
}

/** Cherry-pick one commit onto the current branch. */
export async function cherryPick(cwd: string, hash: string): Promise<void> {
  await runGit(cwd, ['cherry-pick', hash])
}

/** One line's git blame info (final line numbers, 1-based). */
export interface GitBlameLine {
  /** 1-based line number in the blamed file. */
  line: number
  /** Full 40-char commit hash; all-zeros when the line is uncommitted. */
  hash: string
  /** Author name ('' when unavailable). */
  author: string
  /** Author email ('' when unavailable). */
  mail: string
  /** Author date as unix seconds; 0 when unavailable. */
  time: number
  /** Commit subject ('' for uncommitted lines). */
  summary: string
}

/**
 * Parse `git blame --porcelain` output into per-line entries.
 *
 * Porcelain format groups rows per commit: a block header line
 * `<sha> <orig-lineno> <final-lineno> <num-lines>` is followed by header
 * fields (`author`, `author-mail`, `author-time`, `summary`, …) and then
 * `num-lines` body lines (`\t<content>`). Each body line maps to the
 * consecutive result line starting at `final-lineno`. Uncommitted lines
 * carry an all-zero sha.
 */
export function parseBlamePorcelain(output: string): GitBlameLine[] {
  const lines: GitBlameLine[] = []
  let current: { hash: string; author: string; mail: string; time: number; summary: string } | null = null
  let resultLine = 0
  let remaining = 0
  for (const raw of output.split('\n')) {
    // 内容区：porcelain 的内容行总是以 \t 开头（header 字段行不是），
    // 所以用 remaining + \t 双重判定，header 行不会被误消费。
    if (remaining > 0 && raw.startsWith('\t')) {
      lines.push({
        line: resultLine,
        hash: current?.hash ?? '',
        author: current?.author ?? '',
        mail: current?.mail ?? '',
        time: current?.time ?? 0,
        summary: current?.summary ?? '',
      })
      resultLine += 1
      remaining -= 1
      continue
    }
    const header = /^([0-9a-f]{40}) (\d+) (\d+) (\d+)$/.exec(raw)
    if (header !== null) {
      current = { hash: header[1]!, author: '', mail: '', time: 0, summary: '' }
      resultLine = Number.parseInt(header[3]!, 10)
      remaining = Number.parseInt(header[4]!, 10)
      continue
    }
    if (current === null) continue
    if (raw.startsWith('author ')) current.author = raw.slice(7)
    else if (raw.startsWith('author-mail ')) current.mail = raw.slice(12).replace(/[<>]/g, '')
    else if (raw.startsWith('author-time ')) {
      const time = Number.parseInt(raw.slice(12), 10)
      if (Number.isFinite(time)) current.time = time
    } else if (raw.startsWith('summary ')) current.summary = raw.slice(8)
  }
  return lines
}

/**
 * Per-line git blame of one path (working tree vs HEAD). Returns [] when the
 * path is untracked, the directory is not inside a repo, or git fails — the
 * caller treats an empty list as "no blame available" (never an error).
 */
export async function blame(cwd: string, path: string): Promise<GitBlameLine[]> {
  try {
    const raw = await runGit(cwd, ['blame', '--porcelain', '--', path])
    return parseBlamePorcelain(raw)
  } catch {
    return []
  }
}
