/** Bottom terminal: xterm.js over a WebSocket to the host pty.
 *  Wire protocol: input = raw text, resize = JSON {type:'resize',cols,rows}.
 *  The host streams live output only (no transcript replay, P0-02).
 *  Transient disconnects (page refresh, panel toggle) reconnect to the SAME
 *  shell within the host's grace window; a server-side refusal (close code
 *  1011 with a reason) stops the loop and shows the reason with a manual
 *  retry. Reference: dsh-better-sidebar TerminalView (MIT), trimmed. */

import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { XTERM_CSS } from '../xterm-css.ts'

/** Consecutive unreasoned failures before showing the error banner. */
const FAILURE_LIMIT = 3

/** 注入 xterm 样式一次（tsdown 会把 css import 抽成独立 style.css 而 client.js 不加载它，
 *  所以改为字符串注入 <style>）。 */
let xtermCssInjected = false
function ensureXtermCss(): void {
  if (xtermCssInjected) return
  xtermCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-ide-xterm-css', '')
  style.textContent = XTERM_CSS + `
/* dsh-ide-layout 定制：屏幕内容底部对齐 —— 面板拖拽变高时内容贴底不动
   （上方扩展的是终端背景色），松手 fit 后自然填满；底部稳定不抖。
   !important 防止 xterm 运行时内联样式/内部规则覆盖 display 布局 */
.xterm { display: flex !important; flex-direction: column !important; justify-content: flex-end !important; }
`
  document.head.appendChild(style)
}

/** 读取主题 CSS 变量（终端 canvas 需要具体色值，CSS 变量无法用于 canvas 绘制）。
 *  优先从**终端自身容器**读——它能继承 workbench/皮肤的局部变量覆盖（皮肤在
 *  body 上把 --dsw-alias-bg-base 全局设为 transparent，同时给 [data-ide-workbench]
 *  局部覆盖为具体色）。旧实现读 documentElement 只拿到默认值/空 → 皮肤下回退成
 *  白色 canvas、容器却是深蓝 → 每帧 fit 重绘时色差闪烁（「参考 VS Code 仍抖」的根因）。 */
function readThemeColor(el: HTMLElement | null, variable: string, fallback: string): string {
  try {
    const value = getComputedStyle(el ?? document.body).getPropertyValue(variable).trim()
    return value !== '' && value !== 'transparent' ? value : fallback
  } catch {
    return fallback
  }
}

/** 复制文本到剪贴板（含旧引擎 fallback）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** 终端右键菜单项：hover 背景加深；disabled 置灰。 */
function TermMenuItem({ onClick, disabled = false, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }): JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '5px 14px',
        border: 'none', fontSize: 13, fontFamily: 'inherit',
        background: hover ? 'rgba(127,127,127,0.12)' : 'transparent',
        color: disabled ? '#9ca3af' : 'inherit',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

export function TerminalPane({ root, fitTick = 0 }: { root: string; fitTick?: number }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [connected, setConnected] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const connectRef = useRef<(() => void) | null>(null)
  // 外部（面板拖拽结束）触发「立即 fit」，跳过防抖，松手即填充。
  const doFitRef = useRef<(() => void) | null>(null)
  // 终端实例（右键菜单动作需要）+ 右键菜单位置。
  const termRef = useRef<Terminal | null>(null)
  const [termMenu, setTermMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  // 当前 WebSocket（重启终端动作需要发帧/断开）+ 主动重启标记（不累计连接失败）。
  const socketRef = useRef<WebSocket | null>(null)
  const restartingRef = useRef(false)

  useEffect(() => {
    if (fitTick === 0) return
    doFitRef.current?.()
  }, [fitTick])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    ensureXtermCss()
    // 终端 canvas 背景/前景与 DSH 主题变量对齐——canvas 绘制需要具体色值，
    // 且必须与面板容器背景一致，否则拖拽/重绘时内容与容器背景出现色差闪现。
    // 从 host 自身读（继承 workbench 局部变量）；皮肤下 bg-base 是 transparent，
    // 回退到 body 的 layer-1（近不透明层），杜绝白 canvas / 深蓝容器的色差闪烁。
    const bg = readThemeColor(host, '--dsw-alias-bg-base', readThemeColor(null, '--dsw-alias-bg-layer-1', '#ffffff'))
    const fg = readThemeColor(host, '--dsw-alias-label-primary', '#1a1a1a')
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
      theme: {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: bg,
        selectionBackground: 'rgba(96,132,192,0.35)',
      },
      // xterm 5.x 已移除 rendererType（canvas 是唯一渲染器），无需配置
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined
    let failures = 0

    const wsUrl = (): string => {
      const url = new URL('/dsh-ide/ws/terminal', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ root }).toString()
      return url.toString()
    }

    const sendResize = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(wsUrl())
      socketRef.current = socket
      socket.onopen = () => {
        failures = 0
        setConnected(true)
        setFatal(null)
        sendResize()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') term.write(event.data)
      }
      socket.onclose = (event) => {
        socketRef.current = null
        setConnected(false)
        // A server-side refusal carries a close code + reason; retrying it
        // forever would only spin the banner, so surface it with a retry.
        if (event.code === 1011 && event.reason !== '') {
          setFatal(event.reason)
          return
        }
        // 主动重启（右键「重启终端」）：不累计失败，立即重连新 shell。
        if (restartingRef.current) {
          restartingRef.current = false
          failures = 0
          if (!closed) connect()
          return
        }
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          const detail = event.reason !== '' ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
          console.error('[dsh-ide-layout] terminal connection failed:', event.code, event.reason)
          setFatal(`终端连接失败${detail}`)
          return
        }
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }
    connectRef.current = connect

    const inputSub = term.onData((data) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
    })
    // 最终节奏（大都督要求「零时间段」）：
    // - fit 用 rAF 每帧（约 16ms，无感知延迟）→ 拖拽中内容**实时跟手填充**，无任何时间窗口
    // - 「底部抖动」的真凶已另行修复：拖拽时直改 DOM 高度（不触发 React 重渲染），
    //   布局层不再每帧重排（见 EditorPane.beginDragResize）
    // - canvas 背景与容器背景同色（theme 已对齐）→ 重绘无色差闪现
    // - sendResize（通知 pty）150ms 防抖 → 拖拽中不反复打扰 shell，停顿后同步一次
    // - fitTick（松手）立即 fit+resize 兜底
    let fitFrame: number | undefined
    let resizeTimer: number | undefined
    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        // The terminal may be mid-dispose; ignore.
      }
    }
    const scheduleResize = (): void => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined
        sendResize()
      }, 150)
    }
    const scheduleFit = (): void => {
      if (fitFrame !== undefined) return
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined
        doFit()
        scheduleResize()
      })
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    // 外部（手柄松手）触发的立即 fit+resize，跳过 rAF
    doFitRef.current = (): void => {
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
      fitFrame = undefined
      doFit()
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      resizeTimer = undefined
      sendResize()
    }

    // 面板是常驻固定高度，直接 open（若容器恰为零尺寸则等下一次 ResizeObserver）。
    try {
      term.open(host)
      doFit()
      sendResize()
    } catch {
      // Deferred: the next ResizeObserver tick will open it via fit().
    }
    termRef.current = term
    // 右键菜单：拦截浏览器默认菜单，按选中态提供 复制/粘贴/清屏。
    const onTermContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      setTermMenu({ x: event.clientX, y: event.clientY, hasSelection: term.hasSelection() })
    }
    host.addEventListener('contextmenu', onTermContextMenu)

    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer)
      observer.disconnect()
      inputSub.dispose()
      doFitRef.current = null
      host.removeEventListener('contextmenu', onTermContextMenu)
      termRef.current = null
      // 面板隐藏/卸载：只断开 socket（host 侧宽限期后回收 shell）。
      // 不主动发 close frame——同一 root 快速重开可复用同一个 shell。
      socket?.close()
      term.dispose()
      connectRef.current = null
    }
  }, [root])

  // 复制终端选中文本（xterm 选区）。
  const copySelection = (): void => {
    const term = termRef.current
    const menu = termMenu
    setTermMenu(null)
    if (term === null || menu === null || !menu.hasSelection) return
    void copyText(term.getSelection())
  }

  // 从剪贴板粘贴到终端（term.paste 走 WS 当键盘输入发给 shell）。
  const pasteClipboard = (): void => {
    const menu = termMenu
    setTermMenu(null)
    if (menu === null) return
    void navigator.clipboard.readText()
      .then((text) => { if (text !== '') termRef.current?.paste(text) })
      .catch(() => { console.error('[dsh-ide-layout] 剪贴板读取失败（无 clipboard-read 权限）') })
  }

  // 清空终端视口与滚动缓冲（纯前端，不打扰 shell）。
  const clearTerminal = (): void => {
    setTermMenu(null)
    termRef.current?.clear()
  }

  // 重启终端：立即杀当前 shell + 重连全新 shell（不用重启整个 harness）。
  const restartTerminal = (): void => {
    const menu = termMenu
    setTermMenu(null)
    if (menu === null) return
    termRef.current?.clear()
    restartingRef.current = true
    const socket = socketRef.current
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      // 通知 host 立即回收 shell；随后断开，onclose 走「主动重启」分支立即重连。
      socket.send(JSON.stringify({ type: 'restart' }))
      socket.close()
    } else {
      // 连接已断开：直接重连（open 会 spawn 全新 shell）。
      connectRef.current?.()
    }
  }

  // 关闭右键菜单：外部点击或 Esc。
  useEffect(() => {
    if (termMenu === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('[data-ide-term-menu]') !== null) return
      setTermMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTermMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [termMenu])

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {fatal !== null && (
        <div style={{
          padding: '5px 10px', fontSize: 12, color: '#dc2626',
          background: 'rgba(220,38,38,0.08)', borderBottom: '1px solid rgba(220,38,38,0.3)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <span style={{ flex: 1, wordBreak: 'break-all' }}>终端错误：{fatal}</span>
          <button
            type="button"
            onClick={() => { setFatal(null); connectRef.current?.() }}
            style={{
              padding: '1px 10px', fontSize: 12, cursor: 'pointer',
              color: 'inherit', background: 'transparent',
              border: '1px solid currentColor', borderRadius: 4, fontFamily: 'inherit',
            }}
          >
            重试
          </button>
        </div>
      )}
      {fatal === null && !connected && (
        <div style={{ padding: '2px 10px', fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>连接中…</div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      </div>
      {/* 终端右键菜单（复制/粘贴/清屏） */}
      {termMenu !== null && createPortal(
        <div
          data-ide-term-menu=""
          style={{
            position: 'fixed', left: Math.max(4, Math.min(termMenu.x, window.innerWidth - 180)),
            top: Math.max(4, Math.min(termMenu.y, window.innerHeight - 160)),
            zIndex: 2147483000, minWidth: 160, padding: '4px 0',
            // 浮层用 overlay + label-primary 自足背景（皮肤透明化 bg-base 时仍可读）。
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.98))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontSize: 13, fontFamily: 'inherit',
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <TermMenuItem onClick={copySelection} disabled={!termMenu.hasSelection}>📋 复制选中</TermMenuItem>
          <TermMenuItem onClick={pasteClipboard}>📥 粘贴</TermMenuItem>
          <div style={{ height: 1, margin: '4px 8px', background: 'var(--ide-border,#e5e6eb)' }} />
          <TermMenuItem onClick={clearTerminal}>🧹 清屏</TermMenuItem>
          <TermMenuItem onClick={restartTerminal}>🔄 重启终端</TermMenuItem>
        </div>,
        document.body,
      )}
    </>
  )
}
