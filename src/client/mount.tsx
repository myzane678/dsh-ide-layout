/** DOM mounting: FileTree into the sidebar host, EditorPane into the workbench.
 *  v11: the file tree renders inside the shell sidebar (below the workspace
 *  region) so sidebar and tree form one left column; the workbench portal
 *  hosts only the editor. */

import { useEffect, useState, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { IdeState, ListenerStore } from './store.ts'
import { FileTree } from './components/FileTree.tsx'
import { EditorPane } from './components/EditorPane.tsx'
import { GitPanel } from './components/GitPanel.tsx'
import { ProblemsPanel } from './components/ProblemsPanel.tsx'

const WORKBENCH_SELECTOR = '[data-ide-workbench]'
const SIDEBAR_TREE_SELECTOR = '[data-ide-sidebar-tree]'

/** Wait for one selector (the shell/frame mounts after boot settlement). */
function waitForElement(selector: string, onFound: (el: HTMLElement) => void): () => void {
  let disposed = false
  let observer: MutationObserver | undefined
  const tryFind = (): void => {
    if (disposed) return
    const el = document.querySelector<HTMLElement>(selector)
    if (el !== null) {
      observer?.disconnect()
      onFound(el)
    }
  }
  observer = new MutationObserver(() => { tryFind() })
  observer.observe(document.body, { childList: true, subtree: true })
  tryFind()
  return () => {
    disposed = true
    observer?.disconnect()
  }
}

export interface IdeMountApi {
  ide: ListenerStore<IdeState>
  openFile: (path: string, line?: number) => void
  /** 把选中代码追加到聊天输入框（发送给内置 agent）。 */
  askAgent: (text: string, path: string) => void
}

/** The sidebar file tree: follows the ide root (workspace/session).
 *  v13: 顶部「文件 | Git」视图切换；Git 面板复用同一块区域。
 *  v15: 加「问题」视图（LSP 诊断聚合）。 */
function SidebarTree({ api }: { api: IdeMountApi }): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => api.ide.subscribe(() => force((n) => n + 1)), [api.ide])
  const state = api.ide.getSnapshot()
  const [view, setView] = useState<'files' | 'git' | 'problems'>('files')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', flexShrink: 0,
        borderBottom: '1px solid var(--ide-border,#e5e6eb)',
        background: 'var(--ide-tabbar, rgba(127,127,127,0.06))',
      }}>
        {(['files', 'git', 'problems'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            title={key === 'problems' ? '问题面板（LSP 诊断）' : undefined}
            style={{
              flex: 1, padding: '5px 0', fontSize: 12, cursor: 'pointer',
              border: 'none', borderBottom: view === key ? '2px solid var(--ide-accent,#4f8cff)' : '2px solid transparent',
              background: 'transparent', color: view === key ? 'inherit' : '#6b7280',
              fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}
          >
            {key === 'files' ? '📁 文件' : key === 'git' ? '🛠 Git' : '⚠️ 问题'}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === 'files' && <FileTree root={state.root} treeTick={state.treeTick} onOpenFile={api.openFile} />}
        {view === 'git' && <GitPanel root={state.root} />}
        {view === 'problems' && (
          <ProblemsPanel root={state.root} diagnostics={state.diagnostics} onOpenFile={api.openFile} />
        )}
      </div>
    </div>
  )
}

/** The editor pane (workbench). */
function Workbench({ api }: { api: IdeMountApi }): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => api.ide.subscribe(() => force((n) => n + 1)), [api.ide])
  const state = api.ide.getSnapshot()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', height: '100%' }}>
        <EditorPane
          root={state.root}
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onActivate={(id) => api.ide.update((prev) => ({ ...prev, activeTabId: id }))}
          onClose={(id) => api.ide.update((prev) => ({
            ...prev,
            tabs: prev.tabs.filter((tab) => tab.id !== id),
            activeTabId: prev.activeTabId === id ? (prev.tabs[prev.tabs.length - 2]?.id ?? null) : prev.activeTabId,
          }))}
          onContentChange={(id, content) => api.ide.update((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) => tab.id === id ? { ...tab, content, dirty: true } : tab),
          }))}
          onDirtySave={(tab) => api.ide.update((prev) => ({
            ...prev,
            tabs: prev.tabs.map((item) => item.id === tab.id ? { ...tab, dirty: false } : item),
          }))}
          onCloseEditor={() => api.ide.update((prev) => ({
            ...prev,
            editorVisible: false,
            tabs: [],
            activeTabId: null,
          }))}
          onAskAgent={api.askAgent}
          onOpenFile={(path, line) => api.openFile(path, line)}
          onDiagnostics={(uri, diagnostics) => api.ide.update((prev) => ({
            ...prev,
            diagnostics: { ...prev.diagnostics, [uri]: diagnostics },
          }))}
        />
      </div>
    </div>
  )
}

/**
 * Mount both roots.
 * @returns a disposer unmounting both trees.
 */
export function mountPanels(api: IdeMountApi): () => void {
  let sidebarRoot: Root | undefined
  let workbenchRoot: Root | undefined
  const disposers: Array<() => void> = []

  disposers.push(waitForElement(SIDEBAR_TREE_SELECTOR, (el) => {
    sidebarRoot = createRoot(el)
    sidebarRoot.render(createElement(SidebarTree, { api }))
  }))

  disposers.push(waitForElement(WORKBENCH_SELECTOR, (el) => {
    workbenchRoot = createRoot(el)
    workbenchRoot.render(createElement(Workbench, { api }))
  }))

  return () => {
    for (const dispose of disposers) dispose()
    sidebarRoot?.unmount()
    workbenchRoot?.unmount()
  }
}
