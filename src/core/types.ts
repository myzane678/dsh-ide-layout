/** Shared types between the host fs service and the browser half. */

/** One row in a directory listing. */
export interface FsEntry {
  name: string
  /** Relative path from the project root ('' for the root itself). */
  path: string
  isDir: boolean
  size: number
  mtime: number
}

export interface DirListing {
  root: string
  entries: FsEntry[]
}

export interface FileRead {
  content: string
  truncated: boolean
  size: number
  mtime: number
  /** 实际使用的解码编码（'auto' 请求时返回检测结果；默认 'utf-8'）。 */
  encoding: string
}

/** 二进制图片读取结果（base64 + MIME，供编辑器图片预览）。 */
export interface FileReadBinary {
  /** base64 编码的图片字节。 */
  data: string
  mime: string
  size: number
  mtime: number
}

export interface PanelError {
  code: string
  message: string
}

export type PanelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PanelError }

/** One fs change event pushed to the browser (kind 'fs' | 'git'). */
export interface PanelEvent {
  kind: 'fs' | 'git'
  root: string
}

/** LSP languageId for a file path (or null when unsupported). Shared by the
 *  host LSP bridge (server selection) and the browser client (didOpen). */
export function languageIdForPath(path: string): string | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'javascript'
    case 'jsx': return 'javascriptreact'
    case 'ts': case 'mts': case 'cts': return 'typescript'
    case 'tsx': return 'typescriptreact'
    case 'json': case 'jsonc': case 'map': return 'json'
    case 'py': case 'pyw': return 'python'
    case 'ps1': case 'psm1': case 'psd1': return 'powershell'
    case 'java': return 'java'
    default: return null
  }
}
