/**
 * DOM layout controller v11: sidebar-embedded file tree + fixed editor
 * workbench + chat squeeze, chat manually resizable.
 *
 * Learned from dsh-better-sidebar (MIT): never rewrite the AppFrame grid.
 *  1. The file tree is injected INTO the shell sidebar, right after the
 *     workspace/session region (regionArea), so "工作区和文件树在同一栏".
 *     v11 injects WITHOUT touching the sidebar's display/flex layout and
 *     gives the tree host a fixed height (clamp) — v9's flex-based embed
 *     collapsed the host to zero height and v10's separate workbench column
 *     made four visual sections instead of three.
 *  2. The editor workbench is a fixed-position portal between the shell
 *     sidebar and the chat column (proven render path since v10).
 *  3. The center (chat) column is squeezed right with margin-left; the vacated
 *     strip hosts the workbench. A chat drag handle resizes the chat; the
 *     workbench absorbs the rest. Sidebar width follows the native drag.
 *
 * Target: [sidebar: workspaces/sessions | tree] [editor] [chat] [details]
 */

import type { IdeState, LayoutState, ListenerStore } from './store.ts'

/** The editor portal host (mount.tsx renders the EditorPane into it). */
let workbenchHost: HTMLDivElement | null = null
/** The sidebar file-tree host (mount.tsx renders the FileTree into it). */
let sidebarTreeHost: HTMLDivElement | null = null

export function getWorkbenchHost(): HTMLDivElement | null {
  return workbenchHost
}

export function getSidebarTreeHost(): HTMLDivElement | null {
  return sidebarTreeHost
}

/** 精确找真正的 sidebar 容器：`[class*="sidebarCol"]` 是 contains 匹配，可能误命中
 *  类名含 "sidebarCol" 的无关元素（踩过坑）。真正的 sidebar 一定包含 footArea
 *  （左下角设置区）和 regionArea（工作区/会话列表）。 */
function findSidebar(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[class*="sidebarCol"]')
  for (const el of candidates) {
    if (el.querySelector('[class*="footArea"]') !== null || el.querySelector('[class*="regionArea"]') !== null) {
      return el
    }
  }
  // 兜底：第一个候选
  return candidates[0] ?? null
}

/** Locate the frame grid element (sidebar's parent in the AppFrame grid). */
function findFrame(): HTMLElement | null {
  const sidebar = findSidebar()
  if (sidebar !== null && sidebar.parentElement !== null) return sidebar.parentElement
  return null
}

/** 在给定容器内精确找 sidebar（含 footArea/regionArea 的候选）。 */
function findSidebarIn(container: HTMLElement): HTMLElement | null {
  const candidates = container.querySelectorAll<HTMLElement>('[class*="sidebarCol"]')
  for (const el of candidates) {
    if (el.querySelector('[class*="footArea"]') !== null || el.querySelector('[class*="regionArea"]') !== null) {
      return el
    }
  }
  return candidates[0] ?? null
}

const MIN_CHAT_PX = 440
const EDITOR_MIN = 300

/** The layout controller: embed tree, place workbench, squeeze chat. */
export class IdeLayoutController {
  private frame: HTMLElement | null = null
  private chatHandle: HTMLDivElement | null = null
  private sidebarObserver: ResizeObserver | null = null
  private frameObserver: ResizeObserver | null = null
  private detailsObserver: ResizeObserver | null = null
  private footObserver: ResizeObserver | null = null
  private waitObserver: MutationObserver | null = null
  private sidebarInjected = false
  private sidebarWidth = 280
  private frameWidth = 0
  private detailsWidth = 0
  private disposers: Array<() => void> = []

  constructor(
    private readonly layout: ListenerStore<LayoutState>,
    private readonly ide: ListenerStore<IdeState>,
  ) {}

  mount(): void {
    const tryAttach = (): void => {
      if (this.frame === null) {
        const frame = findFrame()
        if (frame === null) return
        this.frame = frame
        this.frameWidth = frame.getBoundingClientRect().width
        this.frameObserver = new ResizeObserver(() => {
          if (this.frame !== null) this.frameWidth = this.frame.getBoundingClientRect().width
          this.apply()
        })
        this.frameObserver.observe(frame)
        this.embedWorkbench()
        this.bindDetails()
      }
      // Retry the sidebar tree embed until the sidebar column renders.
      if (!this.sidebarInjected) {
        const sidebar = this.frame !== null ? findSidebarIn(this.frame) : findSidebar()
        if (sidebar !== null) this.embedSidebarTree(sidebar)
      }
      this.apply()
    }
    this.waitObserver = new MutationObserver(() => { tryAttach() })
    this.waitObserver.observe(document.body, { childList: true, subtree: true })
    tryAttach()
  }

  /** Create the fixed editor workbench portal host + chat handle. */
  private embedWorkbench(): void {
    if (workbenchHost !== null) return
    const host = document.createElement('div')
    host.dataset.ideWorkbench = ''
    host.style.cssText = 'position:fixed;top:0;bottom:0;z-index:20;display:flex;flex-direction:row;overflow:hidden;'
      + 'background:var(--dsw-alias-bg-base,#ffffff);'
    document.body.appendChild(host)
    workbenchHost = host

    // Track sidebar width (native drag) to place the workbench portal.
    this.sidebarObserver = new ResizeObserver(() => {
      const sidebar = this.frame !== null ? findSidebarIn(this.frame) : findSidebar()
      if (sidebar !== null) this.sidebarWidth = sidebar.getBoundingClientRect().width
      this.apply()
    })
    const sidebar = this.frame !== null ? findSidebarIn(this.frame) : findSidebar()
    if (sidebar !== null) this.sidebarObserver.observe(sidebar)

    this.chatHandle = this.createChatHandle()
    this.disposers.push(this.layout.subscribe(() => this.apply()))
    // 编辑区显隐（editorVisible）变化时同步布局
    this.disposers.push(this.ide.subscribe(() => this.apply()))
  }

  /** Track the details column (affects the width budget). */
  private bindDetails(): void {
    this.detailsObserver = new ResizeObserver(() => {
      const details = this.frame?.querySelector<HTMLElement>('[class*="detailsCol"]') ?? null
      this.detailsWidth = details === null ? 0 : details.getBoundingClientRect().width
      this.apply()
    })
    const details = this.frame?.querySelector<HTMLElement>('[class*="detailsCol"]') ?? null
    this.detailsWidth = details === null ? 0 : details.getBoundingClientRect().width
    if (details !== null) this.detailsObserver.observe(details)
  }

  /** 文件树高度（px），可拖拽调整，持久化到 localStorage。 */
  private treeHeight = 0
  /** 被加了 paddingBottom 的滚动元素 + 其原始值（dispose 时恢复）。 */
  private paddedScrollEl: HTMLElement | null = null
  private paddedScrollOriginal = ''
  /** sidebar 自身与 root 容器的 padding 记录（dispose 恢复）。 */
  private sidebarPadEl: HTMLElement | null = null
  private sidebarPadOriginal = ''
  /** 列表滚动容器（强制设置高度，dispose 恢复）。 */
  private listEl: HTMLElement | undefined
  private listOriginalHeight = ''
  private listOriginalMaxHeight = ''

  /**
   * Inject the sidebar file-tree host into the sidebar's flex flow.
   * v16（终版方案）：不再 absolute 覆盖。root（hHd-Xa_root）是 flex column 容器
   * （logoRow → newSession → regionArea(flex:1) → footArea），把文件树作为
   * **flex 子元素**插入 regionArea 之后、footArea 之前：
   *   - regionArea（flex:1）自动收缩到文件树上方 → 列表永不与文件树重叠
   *   - footArea（设置按钮）保持在底部不动
   *   - 不碰任何 padding / 不依赖滚动元素定位，任何 shell 结构都成立
   * 之前 v12~v15.6 的 absolute+padding 方案全部作废（列表被中间层推走/设置被顶起）。
   */
  private embedSidebarTree(sidebar: HTMLElement): void {
    const rootEl = sidebar.querySelector<HTMLElement>('[class*="root"]')
    if (rootEl === null) {
      // root 延迟渲染：不置 injected，让外层 MutationObserver 重试
      return
    }
    this.sidebarInjected = true
    const host = document.createElement('div')
    host.dataset.ideSidebarTree = ''
    host.style.cssText = 'flex:none;height:clamp(200px, 46vh, 720px);'
      + 'overflow:hidden;display:flex;flex-direction:column;'
      + 'border-top:1px solid var(--ide-border,#e5e6eb);'
      + 'background:var(--dsw-alias-bg-base,#ffffff);min-height:120px;'
    // 插入 regionArea 之后、footArea 之前
    const regionEl = rootEl.querySelector<HTMLElement>('[class*="regionArea"]')
    const footEl = rootEl.querySelector<HTMLElement>('[class*="footArea"]')
    if (regionEl !== null && regionEl.nextSibling !== null) {
      rootEl.insertBefore(host, regionEl.nextSibling)
    } else if (footEl !== null) {
      rootEl.insertBefore(host, footEl)
    } else {
      rootEl.appendChild(host)
    }
    sidebarTreeHost = host

    // 文件树高度：默认 clamp(200px,46vh,720px)，可从顶部手柄拖拽（min 120 / max 85vh）
    this.treeHeight = this.loadTreeHeight()
    if (this.treeHeight > 0) {
      host.style.height = `${this.treeHeight}px`
    }
    const handle = document.createElement('div')
    handle.dataset.ideTreeHandle = ''
    handle.style.cssText = 'position:absolute;top:-4px;left:0;right:0;height:8px;cursor:row-resize;z-index:6;'
      + 'background:transparent;'
    handle.title = '拖拽调整文件树高度'
    handle.addEventListener('mouseenter', () => { handle.style.background = 'rgba(127,127,127,0.35)' })
    handle.addEventListener('mouseleave', () => { handle.style.background = 'transparent' })
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = host.getBoundingClientRect().height
      const maxH = window.innerHeight * 0.85
      const onMove = (moveEvent: PointerEvent): void => {
        const next = Math.max(120, Math.min(startHeight + (startY - moveEvent.clientY), maxH))
        host.style.height = `${next}px`
        this.saveTreeHeight(next)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
    host.appendChild(handle)
    // 文件树容器需要 position:relative 才能定位手柄
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  }

  /** 文件树高度持久化：localStorage（会话级布局偏好）。 */
  private loadTreeHeight(): number {
    try {
      const raw = localStorage.getItem('dsh-ide-tree-height')
      const value = raw === null ? 0 : Number.parseInt(raw, 10)
      return Number.isFinite(value) && value > 0 ? value : 0
    } catch {
      return 0
    }
  }

  private saveTreeHeight(px: number): void {
    try {
      localStorage.setItem('dsh-ide-tree-height', String(Math.round(px)))
    } catch {
      // localStorage 不可用时忽略
    }
  }

  private applyRegionBottom: () => void = () => {}

  private createChatHandle(): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'ide-chat-handle'
    // 挂在 body 上（fixed），不放在 workbench 内——workbench 有 overflow:hidden，
    // 手柄压在右边界会被裁剪一半，只剩 4px 命中区导致拖不动。
    el.style.cssText = 'position:fixed;top:0;bottom:0;z-index:40;cursor:col-resize;width:8px;margin-left:-4px;'
      + 'background:transparent;'
    el.addEventListener('mouseenter', () => { el.style.background = 'rgba(127,127,127,0.35)' })
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent' })
    el.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = this.layout.getSnapshot().chatWidth
      const onMove = (moveEvent: PointerEvent): void => {
        // 手柄左移（clientX 减小）= 聊天区左边界左移 = 聊天区变宽，所以取反
        const width = Math.max(MIN_CHAT_PX, startWidth + (startX - moveEvent.clientX))
        this.layout.update((prev) => ({ ...prev, chatWidth: width }))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
    document.body.appendChild(el)
    return el
  }

  /** Squeeze the chat column and place the workbench portal + chat handle.
   *  编辑区按需显隐：editorVisible 为 false 时回到原生两栏
   *  （工作区 sidebar | agent chat），不挤压聊天列、不显示编辑区。 */
  private apply(): void {
    const state = this.layout.getSnapshot()
    const editorVisible = this.ide.getSnapshot().editorVisible
    const frameW = this.frameWidth > 0 ? this.frameWidth : window.innerWidth
    const total = Math.max(0, frameW - this.sidebarWidth - this.detailsWidth)

    // Workbench = total - chat; chat clamps so the workbench keeps its floor.
    const maxChat = Math.max(MIN_CHAT_PX, total - EDITOR_MIN)
    const chat = Math.min(Math.max(MIN_CHAT_PX, state.chatWidth), maxChat)
    const work = editorVisible ? Math.max(EDITOR_MIN, total - chat) : 0

    const centerCol = this.frame?.querySelector<HTMLElement>('[class*="centerCol"]') ?? null
    if (centerCol !== null) {
      centerCol.style.marginLeft = editorVisible ? `${work}px` : '0'
      centerCol.style.minWidth = editorVisible ? '0' : ''
    }
    if (workbenchHost !== null) {
      workbenchHost.style.left = `${this.sidebarWidth}px`
      workbenchHost.style.width = `${work}px`
      workbenchHost.style.pointerEvents = editorVisible && work > 0 ? 'auto' : 'none'
      workbenchHost.style.display = editorVisible ? 'flex' : 'none'
    }
    if (this.chatHandle !== null) {
      // 手柄挂在 body（fixed），用视口绝对坐标：sidebar 右缘 + 编辑器宽度
      this.chatHandle.style.left = `${this.sidebarWidth + work}px`
      this.chatHandle.style.display = editorVisible ? 'block' : 'none'
    }
  }

  /** Detach everything (plugin unload). */
  dispose(): void {
    this.waitObserver?.disconnect()
    this.sidebarObserver?.disconnect()
    this.frameObserver?.disconnect()
    this.detailsObserver?.disconnect()
    this.footObserver?.disconnect()
    for (const dispose of this.disposers) dispose()
    // 恢复被改过 padding-bottom 的元素（sidebar 自身 + root 容器）
    const restorePadding = (el: HTMLElement | null, original: string): void => {
      if (el === null) return
      if (original !== '') el.style.paddingBottom = original
      else el.style.removeProperty('padding-bottom')
    }
    restorePadding(this.paddedScrollEl, this.paddedScrollOriginal)
    restorePadding(this.sidebarPadEl, this.sidebarPadOriginal)
    // 恢复列表容器的原始高度
    if (this.listEl !== undefined) {
      if (this.listOriginalHeight !== '') this.listEl.style.height = this.listOriginalHeight
      else this.listEl.style.removeProperty('height')
      if (this.listOriginalMaxHeight !== '') this.listEl.style.maxHeight = this.listOriginalMaxHeight
      else this.listEl.style.removeProperty('max-height')
    }
    this.paddedScrollEl = null
    this.paddedScrollOriginal = ''
    this.sidebarPadEl = null
    this.sidebarPadOriginal = ''
    this.listEl = undefined
    this.listOriginalHeight = ''
    this.listOriginalMaxHeight = ''
    this.chatHandle?.remove()
    const centerCol = this.frame?.querySelector<HTMLElement>('[class*="centerCol"]') ?? null
    centerCol?.style.removeProperty('margin-left')
    if (workbenchHost !== null) {
      workbenchHost.remove()
      workbenchHost = null
    }
    if (sidebarTreeHost !== null) {
      sidebarTreeHost.remove()
      sidebarTreeHost = null
    }
    this.frame = null
    this.sidebarInjected = false
  }
}
