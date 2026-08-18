/** DOM mounting: FileTree into the sidebar host, EditorPane into the workbench.
 *  v11: the file tree renders inside the shell sidebar (below the workspace
 *  region) so sidebar and tree form one left column; the workbench portal
 *  hosts only the editor. */

import { useEffect, useState, createElement, type JSX, type CSSProperties } from 'react'
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
 *  v15: 加「问题」视图（LSP 诊断聚合）。
 *  v17: 改为文件树常驻主视图 + 右上角小图标切换 Git/问题（方案 B，大确定）：
 *  左侧标题显示当前视图名，点标题或激活图标回到文件树；问题图标带诊断计数角标。 */
function SidebarTree({ api }: { api: IdeMountApi }): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => api.ide.subscribe(() => force((n) => n + 1)), [api.ide])
  const state = api.ide.getSnapshot()
  const [view, setView] = useState<'files' | 'git' | 'problems'>('files')
  // 诊断计数角标：聚合所有打开文件的 LSP 诊断（错误+警告）。
  const problemCount = Object.values(state.diagnostics).reduce((total, list) => total + list.length, 0)
  const viewTitle = view === 'files' ? '资源管理器' : view === 'git' ? '源代码管理' : '问题'
  const toggle = (key: 'git' | 'problems'): void => setView((prev) => (prev === key ? 'files' : key))
  const iconButton: CSSProperties = {
    width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13,
    padding: 0, borderRadius: 4, fontFamily: 'inherit',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* 标题行：当前视图名 + Git/问题 小图标切换 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', flexShrink: 0,
        borderBottom: '1px solid var(--ide-border,#e5e6eb)',
        background: 'var(--ide-tabbar, rgba(127,127,127,0.06))',
      }}>
        <span
          title="回到文件树"
          onClick={() => setView('files')}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            color: 'var(--ide-muted,#6b7280)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {viewTitle}
        </span>
        <button
          type="button"
          onClick={() => toggle('problems')}
          title={problemCount > 0 ? `问题面板（${problemCount} 项诊断）` : '问题面板'}
          style={{
            ...iconButton, opacity: view === 'problems' ? 1 : 0.55,
            background: view === 'problems' ? 'var(--ide-hover, rgba(127,127,127,0.12))' : 'transparent',
            position: 'relative',
          }}
        >
          ⚠️
          {problemCount > 0 && (
            <span style={{
              position: 'absolute', top: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px',
              background: '#dc2626', color: '#fff', fontSize: 9, lineHeight: '14px', textAlign: 'center',
              borderRadius: 8, boxSizing: 'border-box',
            }}>
              {problemCount > 99 ? '99+' : problemCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => toggle('git')}
          title="Git 面板"
          style={{
            ...iconButton, opacity: view === 'git' ? 1 : 0.55,
            background: view === 'git' ? 'var(--ide-hover, rgba(127,127,127,0.12))' : 'transparent',
          }}
        >
          🛠
        </button>
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
