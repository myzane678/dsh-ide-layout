/**
 * dsh-ide-layout — browser half: mounts the IDE layout (left file tree +
 * center editor) into the web shell's frame grid through the layout
 * controller, follows the active session's cwd as the project root, and
 * subscribes to the host fs change stream.
 *
 * Failure policy: every DOM/runtime wiring failure is logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { IdeLayoutController } from './layout.ts'
import { createStore, IDE_DEFAULT, LAYOUT_DEFAULT, type IdeState } from './store.ts'
import { mountPanels, type IdeMountApi } from './mount.tsx'
import { subscribeChanges } from './api.ts'
import { openFileInTabs } from './components/EditorPane.tsx'

/** Required services: sessions + workspaces for the project root. */
export const inject = ['sessions', 'workspaces']

/** Apply the browser half. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const ide = createStore<IdeState>(IDE_DEFAULT)
    const layout = createStore(LAYOUT_DEFAULT)
    const controller = new IdeLayoutController(layout, ide)
    const disposers: Array<() => void> = []
    let disposeEvents: (() => void) | undefined
    let disposePanels: (() => void) | undefined
    let currentRoot = ''
    /** fs 变更事件防抖：合并高频事件（如 agent 写会话文件），避免连续刷新。 */
    let treeRefreshTimer: ReturnType<typeof setTimeout> | undefined
    /** Force the FileTree to re-list (fs changed on disk).
     *  轻量方案：bump treeTick → FileTree 保留展开状态重载数据；
     *  不重挂载 panels（旧方案每次 fs 变更都重建文件树/编辑器/终端 → 闪烁）。 */
    const refreshTree = (): void => {
      if (treeRefreshTimer !== undefined) return
      treeRefreshTimer = setTimeout(() => {
        treeRefreshTimer = undefined
        ide.update((prev) => ({ ...prev, treeTick: prev.treeTick + 1 }))
      }, 400)
    }

    const api: IdeMountApi = {
      ide,
      openFile: (path: string) => {
        // P1-06：函数式 update，迟到的读取合并进最新 tabs，不覆盖并发打开的文件。
        void openFileInTabs(ide.getSnapshot().root, path, (updater) => {
          ide.update((prev) => {
            const next = updater({ tabs: prev.tabs, activeTabId: prev.activeTabId })
            return { ...prev, tabs: next.tabs, activeTabId: next.activeTabId, editorVisible: true }
          })
        })
      },
      // 选中代码 → 追加到当前会话的聊天输入框（draft），由用户确认后发送。
      // 参考 better-sidebar appendToDraft：经 ctx.get('conversation') 懒取服务，
      // 失败降级为日志，绝不崩溃。
      askAgent: (text: string, path: string) => {
        try {
          const sessionSnapshot = ctx.sessions.list.getSnapshot()
          const sessionId = sessionSnapshot.current as SessionId | undefined
          if (sessionId === undefined) return
          const actx = ctx.sessions.scope(sessionId)
          if (actx === undefined) return
          const conversation = (ctx as unknown as { get: (key: string) => unknown }).get('conversation') as
            | { input: { for(a: unknown): { state: { getSnapshot(): { draft: string } }; setDraft(t: string): void } } }
            | undefined
          if (conversation === undefined) return
          const input = conversation.input.for(actx)
          const draft = input.state.getSnapshot().draft
          const block = `请分析/修改这段代码（文件：${path}）：\n\n\`\`\`\n${text}\n\`\`\``
          input.setDraft(draft.trim() === '' ? block : `${draft}\n\n${block}`)
        } catch (error) {
          console.error('[dsh-ide-layout] askAgent failed:', error)
        }
      },
    }

    const remountPanels = (): void => {
      disposePanels?.()
      disposePanels = mountPanels(api)
    }

    // The project root follows the active session's cwd, falling back to the
    // most recent (then first) registered workspace so the tree shows files
    // even before any session is opened.
    const bindRoot = (): void => {
      try {
        const sessionSnapshot = ctx.sessions.list.getSnapshot()
        const sessionId = sessionSnapshot.current as SessionId | undefined
        const cwd = sessionId === undefined ? undefined : sessionSnapshot.byId[sessionId]?.cwd
        let root = typeof cwd === 'string' && cwd !== '' ? cwd : ''
        if (root === '') {
          const workspaceSnapshot = ctx.workspaces.list.getSnapshot()
          const recent = workspaceSnapshot.recentWorkspaceId
          const recentView = recent === undefined
            ? undefined
            : workspaceSnapshot.items.find((item) => item.workspaceId === recent)
          const first = workspaceSnapshot.items[0]
          const candidate = recentView?.path ?? first?.path
          root = typeof candidate === 'string' && candidate !== '' ? candidate : ''
        }
        if (root === currentRoot) return
        // P1-05：切换 session/工作区会清空编辑区，dirty tab 先确认，避免静默丢弃。
        const dirtyCount = ide.getSnapshot().tabs.filter((tab) => tab.dirty).length
        if (dirtyCount > 0 && !window.confirm(`切换工作区将关闭编辑区，${dirtyCount} 个文件有未保存的修改，确定继续？`)) {
          return
        }
        currentRoot = root
        // P2-05：切 root 清空诊断缓存（旧工作区 URI 的诊断不再显示）。
        ide.update((prev) => ({ ...prev, root, tabs: [], activeTabId: null, diagnostics: {} }))
        disposeEvents?.()
        disposeEvents = undefined
        if (root !== '') {
          disposeEvents = subscribeChanges(root, refreshTree)
        }
        remountPanels()
      } catch (error) {
        // A failing workspaces/sessions read must never take the layout down.
        console.error('[dsh-ide-layout] bindRoot failed:', error)
      }
    }

    disposers.push(ctx.sessions.list.subscribe(bindRoot))
    const workspacesMaybe = (ctx as unknown as { workspaces?: { list?: { subscribe?: unknown } } }).workspaces
    if (typeof workspacesMaybe === 'object' && workspacesMaybe !== null && typeof workspacesMaybe.list?.subscribe === 'function') {
      disposers.push((workspacesMaybe as { list: { subscribe: (fn: () => void) => () => void } }).list.subscribe(bindRoot))
    }
    bindRoot()

    try {
      controller.mount()
      remountPanels()
    } catch (error) {
      console.error('[dsh-ide-layout] mount failed:', error)
    }

    return () => {
      if (treeRefreshTimer !== undefined) clearTimeout(treeRefreshTimer)
      disposeEvents?.()
      disposePanels?.()
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  }, 'dsh-ide-layout: wiring')
}
