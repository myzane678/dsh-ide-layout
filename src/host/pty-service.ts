/**
 * PTY service for the IDE terminal: one node-pty shell per canonical
 * workspace root (P0-02). Each root gets its own shell, so different
 * workspaces / windows never share or steal a terminal. A shell survives
 * WebSocket disconnects (page refresh) for a grace period via connection
 * reference counting: the kill timer only starts when the LAST connection
 * to that root drops. Historical output is NOT replayed to new connections
 * (conservative: a new connection must not read a previous session's
 * transcript). Reference: dsh-better-sidebar pty-manager (MIT), reworked
 * for per-root isolation.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty'

/** The interactive shell for this platform (Windows short-circuits). */
function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const envShell = process.env.SHELL
  if (envShell !== undefined && envShell.trim() !== '') return envShell
  return '/bin/bash'
}

/** One live terminal (per canonical root). */
export interface PtyHandle {
  /** The cwd the process was spawned with (a changed root respawns). */
  cwd: string
  pty: IPty
  /** Active socket connections to this shell (reference count). */
  connections: number
  exited: boolean
  exitCode?: number | null
}

/** Per-root terminal registry with reconnect grace. */
export class PtyService {
  private readonly sessions = new Map<string, PtyHandle>()
  private readonly pendingClose = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Open (or reuse) the terminal for a root and register one connection.
   * A handle whose process already exited — or whose spawn cwd differs from
   * the now-authoritative root — is replaced with a fresh spawn. Reopening
   * cancels any pending scheduled close for that root.
   */
  open(cwd: string, cols: number, rows: number): PtyHandle {
    this.cancelClose(cwd)
    const existing = this.sessions.get(cwd)
    if (existing !== null && existing !== undefined && !existing.exited && existing.cwd === cwd) {
      existing.connections += 1
      return existing
    }
    if (existing !== undefined) this.close(cwd)
    const args = process.platform === 'win32' ? [] : ['-l']
    const handle: PtyHandle = {
      cwd,
      pty: ptySpawn(defaultShell(), args, {
        name: 'xterm-256color',
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(2, Math.floor(rows)),
        cwd,
        env: { ...process.env },
      }),
      connections: 1,
      exited: false,
    }
    handle.pty.onExit(({ exitCode }) => {
      handle.exited = true
      handle.exitCode = exitCode
    })
    this.sessions.set(cwd, handle)
    return handle
  }

  /** The live handle for a root, or null. */
  get(cwd: string): PtyHandle | null {
    return this.sessions.get(cwd) ?? null
  }

  /**
   * Release one connection for a root. The shell is kept alive while any
   * connection remains; the kill timer starts only when the LAST connection
   * drops (reconnect grace).
   */
  release(cwd: string, delayMs: number): void {
    const handle = this.sessions.get(cwd)
    if (handle === undefined) return
    handle.connections = Math.max(0, handle.connections - 1)
    if (handle.connections > 0) return
    this.cancelClose(cwd)
    this.pendingClose.set(cwd, setTimeout(() => this.close(cwd), delayMs))
  }

  /** Cancel a pending scheduled close (the terminal is being reopened). */
  cancelClose(cwd: string): void {
    const timer = this.pendingClose.get(cwd)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pendingClose.delete(cwd)
    }
  }

  /** Kill the shell for a root and drop its state. */
  close(cwd: string): void {
    this.cancelClose(cwd)
    const handle = this.sessions.get(cwd)
    if (handle === undefined) return
    this.sessions.delete(cwd)
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
  }

  /** Close everything (plugin teardown). */
  disposeAll(): void {
    for (const cwd of [...this.sessions.keys()]) this.close(cwd)
  }
}
