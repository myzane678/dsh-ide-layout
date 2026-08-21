/** Minimal store helpers (subscribe/update) for the IDE panels. */

import type { LspDiagnostic } from './lsp-client.ts'

export interface ListenerStore<T> {
  getSnapshot(): T
  update(fn: (prev: T) => T): void
  subscribe(listener: () => void): () => void
}

export function createStore<T>(initial: T): ListenerStore<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    update: (fn) => {
      state = fn(state)
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** One open editor tab. */
export interface EditorTab {
  id: string
  path: string
  title: string
  content: string
  dirty: boolean
  savedMtime?: number
  /** 文件过大被截断（>500K 字符）：只读，禁止保存（P1-04）。 */
  truncated?: boolean
  /** 文件类型：text（默认）| image（位图预览，只读）。 */
  kind?: 'text' | 'image'
  /** 文本编码（host 实际使用的解码/写入编码，如 utf-8 / gb18030）；图片 tab 无。 */
  encoding?: string
}

export interface IdeState {
  root: string
  /** Expanded directory paths (relative). */
  expanded: Set<string>
  /** Open editor tabs. */
  tabs: EditorTab[]
  activeTabId: string | null
  /** 编辑区是否可见：默认隐藏（原生两栏：工作区 | agent），
   *  点文件树中的文件时置为 true，关闭按钮可置回 false。 */
  editorVisible: boolean
  /** 文件树刷新计数器：fs 变更时 +1，FileTree 收到后轻量重载（不重挂载组件）。 */
  treeTick: number
  /** LSP 诊断缓存：key = 归一化 file:// uri，value = 最新诊断列表。
   *  由 EditorPane 上抛写入（问题面板 ProblemsPanel 读取）。 */
  diagnostics: Record<string, LspDiagnostic[]>
}

export const IDE_DEFAULT: IdeState = {
  root: '',
  expanded: new Set(),
  tabs: [],
  activeTabId: null,
  editorVisible: false,
  treeTick: 0,
  diagnostics: {},
}

/** Layout preferences: chat is directly draggable; the editor absorbs the
 *  remaining space; the file tree lives inside the sidebar (native width). */
export interface LayoutState {
  chatWidth: number
  availableWidth: number
}

export const LAYOUT_DEFAULT: LayoutState = {
  chatWidth: 520,
  availableWidth: 0,
}
