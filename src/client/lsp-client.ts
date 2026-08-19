/**
 * Browser-side LSP client for the IDE editor: one WebSocket per workspace
 * root talking to the host's language-server bridge (/dsh-ide/ws/lsp).
 * Speaking the real LSP protocol (JSON-RPC over the socket), this module owns:
 *  - connection lifecycle (reconnect with backoff, fatal-refusal stops)
 *  - document lifecycle (didOpen / didChange / didClose with versioning)
 *  - completion requests (CodeMirror autocomplete source)
 *  - diagnostics fan-out (server publishDiagnostics → linter callbacks)
 * Positions use LSP's 0-based {line, character}; conversion to/from CodeMirror
 * offsets happens in the editor integration, not here.
 */

import { languageIdForPath } from '../core/types.ts'

/** LSP protocol message shapes (the subset the IDE uses). */
export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextDocumentIdentifier {
  uri: string
}

export interface LspVersionedTextDocumentIdentifier extends LspTextDocumentIdentifier {
  version: number
}

export interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { kind: string; value: string }
  insertText?: string
  insertTextFormat?: number
  textEdit?: { range: LspRange; newText: string }
  sortText?: string
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: number | string
  source?: string
  message: string
}

/** LSP hover result contents: plain string or MarkupContent / MarkedString list. */
export type LspHoverContents =
  | string
  | Array<string | { language?: string; value: string }>
  | { kind: string; value: string }

export interface LspHover {
  contents: LspHoverContents
  range?: LspRange
}

/** A definition location (textDocument/definition result entry). */
export interface LspLocation {
  uri: string
  range: LspRange
}

/** A single text edit (textDocument/formatting & codeAction edit). */
export interface LspTextEdit {
  range: LspRange
  newText: string
}

/** One changed file inside a WorkspaceEdit (rename / codeAction). */
export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null }
  edits: LspTextEdit[]
}

/** WorkspaceEdit: changed files → edits (textDocument/rename / codeAction edit). */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: LspTextDocumentEdit[]
}

/** A code action candidate (textDocument/codeAction). */
export interface LspCodeAction {
  title: string
  kind?: string
  diagnostics?: LspDiagnostic[]
  edit?: LspWorkspaceEdit
  command?: { command: string; title: string; arguments?: unknown[] }
  isPreferred?: boolean
}

/** Diagnostic severities (LSP: 1=Error, 2=Warning, 3=Information, 4=Hint). */
export const LSP_SEVERITY = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const

/** Path → file:// URI (Windows paths backslash-normalised). */
export function pathToUri(root: string, path: string): string {
  const joined = `${root.replaceAll('\\', '/')}/${path.replaceAll('\\', '/')}`
  return `file:///${joined}`
}

/** 归一化 URI 用于匹配（Windows：盘符大小写 + 百分号编码冒号）。 */
export function normalizeUri(uri: string): string {
  let decoded = uri
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    // Keep as-is on malformed escapes.
  }
  // 浏览器侧无 process.platform；DSH 桌面端在 Windows 上运行，盘符大小写不敏感。
  const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent)
  return isWindows ? decoded.toLowerCase() : decoded
}

/** Completion kinds (LSP) → CodeMirror completion type icons. */
const KIND_TO_TYPE: Record<number, string> = {
  1: 'text', 2: 'method', 3: 'function', 4: 'constructor', 5: 'field',
  6: 'variable', 7: 'class', 8: 'interface', 9: 'module', 10: 'property',
  11: 'unit', 12: 'value', 13: 'enum', 14: 'keyword', 15: 'snippet',
  16: 'color', 17: 'file', 18: 'reference', 19: 'folder', 20: 'enumMember',
  21: 'constant', 22: 'struct', 23: 'event', 24: 'operator', 25: 'typeParameter',
}

/** Completion kind number → CodeMirror type string. */
export function completionType(kind?: number): string {
  return kind !== undefined ? (KIND_TO_TYPE[kind] ?? 'text') : 'text'
}

/** Extract a plain-string documentation value from an LSP doc entry. */
export function completionInfo(documentation?: string | { kind: string; value: string }): string | undefined {
  if (documentation === undefined) return undefined
  return typeof documentation === 'string' ? documentation : documentation.value
}

/** JSON-RPC message envelope over the wire. */
type RpcMessage =
  | { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }
  | { jsonrpc: '2.0'; method: string; params?: unknown }

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 4000
/** Server refusals with a reason stop the retry loop (like the terminal). */
const FATAL_CLOSE_CODE = 1011

export interface LspClientOptions {
  root: string
  /** The file:// URI the server should treat as the workspace root. */
  rootUri: string
  /** 语言服务器类型：'ts'（typescript-language-server）或 'py'（pyright）。 */
  server?: 'ts' | 'py'
  /** 诊断回调：uri 已归一化（与 pathToUri 输出一致，Windows 盘符小写化）。 */
  onDiagnostics: (uri: string, diagnostics: LspDiagnostic[]) => void
  /** Server process died / connection refused permanently. */
  onFatal?: (reason: string) => void
  onOpen?: () => void
}

/**
 * One LSP session per workspace root. Documents are registered with
 * `openDocument(path)` (didOpen on first registration), updated through
 * `updateDocument(path, text)` (didChange, version bump) and released with
 * `closeDocument(path)` (didClose). The socket reconnects automatically; open
 * documents are re-synced after a reconnect (initialize → didOpen replay).
 */
export class LspClient {
  private socket: WebSocket | null = null
  private closed = false
  private retryTimer: number | undefined
  private attempts = 0
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly notifications = new Map<string, (params: unknown) => void>()
  /** Registered documents: path → { uri, version, text, opened }. */
  private readonly docs = new Map<string, { uri: string; version: number; text: string; opened: boolean; path: string }>()
  private initialized = false

  constructor(private readonly options: LspClientOptions) {}

  /** True once the socket is open (used for status display). */
  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Register a document with the server (didOpen). Idempotent per path. */
  openDocument(path: string, text: string): void {
    const existing = this.docs.get(path)
    if (existing !== undefined) {
      existing.text = text
      return
    }
    const uri = pathToUri(this.options.root, path)
    this.docs.set(path, { uri, version: 1, text, opened: false, path })
    if (this.initialized && this.isOpen) this.sendOpen(this.docs.get(path)!)
  }

  /** Push an edit (full text) to the server (didChange). */
  updateDocument(path: string, text: string): void {
    const doc = this.docs.get(path)
    if (doc === undefined) return
    if (doc.text === text) return
    doc.text = text
    doc.version += 1
    if (this.initialized && this.isOpen) this.sendChange(doc)
  }

  /** Release a document (didClose). */
  closeDocument(path: string): void {
    const doc = this.docs.get(path)
    if (doc === undefined) return
    this.docs.delete(path)
    if (doc.opened && this.initialized && this.isOpen) {
      this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    }
  }

  /** Request textDocument/completion for a position; null when closed. */
  async completion(path: string, position: LspPosition): Promise<LspCompletionItem[] | null> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return null
    const result = await this.request('textDocument/completion', {
      textDocument: { uri: doc.uri },
      position,
    })
    if (result === null) return null
    // LSP: CompletionList | CompletionItem[] | null.
    if (Array.isArray(result)) return result as LspCompletionItem[]
    const list = result as { items?: LspCompletionItem[] }
    return list.items ?? null
  }

  /** LSP hover result: { value } | { kind, value }[] | string | null. */
  async hover(path: string, position: LspPosition): Promise<LspHover | null> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return null
    const result = await this.request('textDocument/hover', {
      textDocument: { uri: doc.uri },
      position,
    })
    if (result === null || typeof result !== 'object') return null
    return result as LspHover
  }

  /** Request textDocument/definition for a position; empty array when none. */
  async definition(path: string, position: LspPosition): Promise<LspLocation[]> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return []
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: doc.uri },
      position,
    })
    // LSP: Location | Location[] | LocationLink[] | null.
    if (result === null) return []
    if (Array.isArray(result)) return result as LspLocation[]
    return [result as LspLocation]
  }

  /** Request textDocument/rename → WorkspaceEdit (null when no-op). */
  async rename(path: string, position: LspPosition, newName: string): Promise<LspWorkspaceEdit | null> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return null
    const result = await this.request('textDocument/rename', {
      textDocument: { uri: doc.uri },
      position,
      newName,
    })
    if (result === null || typeof result !== 'object') return null
    return result as LspWorkspaceEdit
  }

  /** Request textDocument/formatting (full-document). Empty array when no-op. */
  async formatting(path: string, options?: { tabSize?: number; insertSpaces?: boolean }): Promise<LspTextEdit[]> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return []
    const result = await this.request('textDocument/formatting', {
      textDocument: { uri: doc.uri },
      options: {
        tabSize: options?.tabSize ?? 4,
        insertSpaces: options?.insertSpaces ?? true,
      },
    })
    if (result === null) return []
    return result as LspTextEdit[]
  }

  /** Request textDocument/codeAction for a range; empty array when none. */
  async codeAction(path: string, range: LspRange, context?: { diagnostics?: LspDiagnostic[] }): Promise<LspCodeAction[]> {
    const doc = this.docs.get(path)
    if (doc === undefined || !this.initialized || !this.isOpen) return []
    const result = await this.request('textDocument/codeAction', {
      textDocument: { uri: doc.uri },
      range,
      context: { diagnostics: context?.diagnostics ?? [] },
    })
    if (result === null) return []
    return result as LspCodeAction[]
  }

  /** Register a notification handler (e.g. textDocument/publishDiagnostics). */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifications.set(method, handler)
  }

  /** Fire a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return
    const message: RpcMessage = { jsonrpc: '2.0', method, params }
    this.socket.send(JSON.stringify(message))
  }

  /** Fire a JSON-RPC request and await the result (10s timeout). */
  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('LSP socket not open'))
        return
      }
      const id = this.nextId++
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, 10_000)
      this.pending.set(id, {
        resolve: (value) => { window.clearTimeout(timer); resolve(value) },
        reject: (error) => { window.clearTimeout(timer); reject(error) },
      })
      const message: RpcMessage = { jsonrpc: '2.0', id, method, params }
      this.socket.send(JSON.stringify(message))
    })
  }

  /** Start connecting (called once by the owner). */
  connect(): void {
    this.attempts = 0
    this.openSocket()
  }

  /** Tear down forever (editor closed). */
  dispose(): void {
    this.closed = true
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer)
    this.socket?.close()
    this.socket = null
    for (const { reject } of this.pending.values()) reject(new Error('LSP client disposed'))
    this.pending.clear()
  }

  private openSocket(): void {
    if (this.closed) return
    const url = new URL('/dsh-ide/ws/lsp', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const params: Record<string, string> = { root: this.options.root }
    if (this.options.server !== undefined) params.server = this.options.server
    url.search = new URLSearchParams(params).toString()
    let socket: WebSocket
    try {
      socket = new WebSocket(url.toString())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.attempts = 0
      void this.initialize()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      this.handleMessage(event.data)
    }
    socket.onclose = (event) => {
      this.initialized = false
      this.socket = null
      for (const { reject } of this.pending.values()) reject(new Error('LSP socket closed'))
      this.pending.clear()
      if (event.code === FATAL_CLOSE_CODE && event.reason !== '') {
        this.options.onFatal?.(event.reason)
        return
      }
      if (this.closed) return
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      socket.close()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== undefined) return
    this.attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined
      this.openSocket()
    }, delay)
  }

  private handleMessage(data: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(data) as RpcMessage
    } catch {
      return
    }
    if ('id' in message && message.id !== undefined && typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (entry !== undefined) {
        this.pending.delete(message.id)
        if ('error' in message && message.error !== undefined) {
          entry.reject(new Error(message.error.message))
        } else {
          entry.resolve('result' in message ? message.result : undefined)
        }
      } else if ('method' in message && message.method !== undefined) {
        // 服务器主动发来的请求：workspace/configuration（pyright/tsserver 都会问）——
        // 返回对应语言服务器的宽松配置；其余请求回空响应，避免服务器阻塞。
        if (message.method === 'workspace/configuration') {
          const params = message.params as { items?: Array<{ section?: string }> } | undefined
          const result = (params?.items ?? []).map((item) => this.configFor(item.section))
          this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
        } else {
          this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }))
        }
      }
      return
    }
    if ('method' in message && message.method !== undefined) {
      // publishDiagnostics is fanned out through the owner callback so the
      // editor can cache per-uri diagnostics without subscribing twice.
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined
        if (params?.uri !== undefined) {
          // 服务器返回的 uri 可能带百分号编码（Windows 冒号 → %3A），归一化后
          // 与 pathToUri 输出对齐，EditorPane 才能按 pathToUri(root, path) 查到。
          this.options.onDiagnostics(normalizeUri(params.uri), params.diagnostics ?? [])
        }
      }
      this.notifications.get(message.method)?.(message.params)
    }
  }

  /** 服务器 workspace/configuration 请求的响应：按 section 返回宽松配置。
   *  pyright 默认对无类型标注的第三方库（mne/scipy 等）做深度推断 → 大量误报；
   *  useLibraryCodeForTypes:false 把它们当 Any（= VS Code Pylance 行为）。
   *  tsserver 不关心这些配置，返回 null 即可。 */
  private configFor(section: string | undefined): unknown {
    if (this.options.server === 'py' && section === 'pyright') {
      return { strict: false, useLibraryCodeForTypes: false }
    }
    if (this.options.server === 'py' && section === 'python') {
      return { analysis: { typeCheckingMode: 'basic', useLibraryCodeForTypes: false } }
    }
    return null
  }

  private async initialize(): Promise<void> {
    try {
      await this.request('initialize', {
        processId: null,
        rootUri: this.options.rootUri,
        // workspaceFolders 是必需的：pyright 没有它会认为工作区不存在，
        // 从而回退默认严格模式、不加载任何项目配置（诊断误报的根因之一）。
        workspaceFolders: [{ uri: this.options.rootUri, name: this.options.root }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            completion: { completionItem: { snippetSupport: false } },
            publishDiagnostics: {},
          },
          workspace: { configuration: true },
        },
      })
      this.notify('initialized', {})
      // 主动推送宽松配置（某些服务器只认 didChangeConfiguration，不等 configuration 请求）。
      if (this.options.server === 'py') {
        this.notify('workspace/didChangeConfiguration', {
          settings: { pyright: { strict: false, useLibraryCodeForTypes: false } },
        })
      }
      this.initialized = true
      // Replay all registered documents (fresh server state after reconnect).
      for (const doc of this.docs.values()) {
        doc.version += 1
        this.sendOpen(doc)
      }
      this.options.onOpen?.()
    } catch {
      // P1-03：初始化失败 → 主动关闭 socket（触发带退避的 onclose 重连），
      // 绝不保留「OPEN 但未初始化」的假连接。
      this.socket?.close()
      this.socket = null
    }
  }

  private sendOpen(doc: { uri: string; version: number; text: string; path?: string; opened: boolean }): void {
    doc.opened = true
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: doc.uri,
        languageId: languageIdForPath(doc.path ?? '') ?? 'plaintext',
        version: doc.version,
        text: doc.text,
      },
    })
  }

  private sendChange(doc: { uri: string; version: number; text: string }): void {
    this.notify('textDocument/didChange', {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.text }],
    })
  }
}
