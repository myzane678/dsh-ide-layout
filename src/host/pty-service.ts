/**
 * PTY service for the IDE terminal: one node-pty shell per workspace root.
 * The shell survives WebSocket disconnects (page refresh) for a grace period
 * and reconnects to the same process; the terminal is a single fixed panel
 * (no tabs), so one live handle is enough. Output is mirrored into a bounded
 * transcript ring so a new connection replays history before live data.
 * Reference: dsh-better-sidebar pty-manager (MIT), trimmed to the IDE scope.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty'

/** Per-terminal transcript bound (bytes kept for replay). */
const TRANSCRIPT_LIMIT = 1 << 20

/** The interactive shell for this platform (Windows short-circuits). */
function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const envShell = process.env.SHELL
  if (envShell !== undefined && envShell.trim() !== '') return envShell
  return '/bin/bash'
}

/** One live terminal. */
export interface PtyHandle {
  /** The cwd the process was spawned with (a changed root respawns). */
  cwd: string
  pty: IPty
  /** Output accumulated since spawn (bounded; head dropped over the limit). */
  transcript: string
  exited: boolean
  exitCode?: number | null
}

/** Single-terminal registry with reconnect grace. */
export class PtyService {
  private session: PtyHandle | null = null
  private pendingClose: ReturnType<typeof setTimeout> | undefined

  /**
   * Open (or reuse) the terminal for a root. A handle whose process already
   * exited — or whose spawn cwd differs from the now-authoritative root — is
   * replaced with a fresh spawn. Reopening cancels any pending scheduled
   * close (a reconnect within the grace window keeps the shell alive).
   */
  open(cwd: string, cols: number, rows: number): PtyHandle {
    this.cancelClose()
    const existing = this.session
    if (existing !== null && !existing.exited && existing.cwd === cwd) return existing
    if (existing !== null) this.close()
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
      transcript: '',
      exited: false,
    }
    handle.pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > TRANSCRIPT_LIMIT) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
      }
    })
    handle.pty.onExit(({ exitCode }) => {
      handle.exited = true
      handle.exitCode = exitCode
    })
    this.session = handle
    return handle
  }

  /** The live handle, or null. */
  get(): PtyHandle | null {
    return this.session
  }

  /** Schedule destruction after `delayMs` (bare socket drop grace). */
  scheduleClose(delayMs: number): void {
    if (this.session === null) return
    this.cancelClose()
    this.pendingClose = setTimeout(() => this.close(), delayMs)
  }

  /** Cancel a pending scheduled close (the terminal is being reopened). */
  cancelClose(): void {
    if (this.pendingClose !== undefined) {
      clearTimeout(this.pendingClose)
      this.pendingClose = undefined
    }
  }

  /** Kill the shell and drop its state. */
  close(): void {
    this.cancelClose()
    if (this.session === null) return
    const handle = this.session
    this.session = null
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
  }

  /** Close everything (plugin teardown). */
  disposeAll(): void {
    this.close()
  }
}
