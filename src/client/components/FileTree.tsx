/** Left column: workspace file tree (dirs + files, lazy expand, click opens).
 *  v13: VS Code 风格右键菜单（在资源管理器中显示 / 复制路径 / 复制相对路径 /
 *  新建文件 / 新建文件夹 / 重命名 / 删除）+ 行内改名与新建输入 + 删除确认浮层。
 *  目录数据由本组件缓存（LevelData map，参考 better-sidebar ExplorerView 模式），
 *  操作成功或收到 fs 变更（外层 SSE 重挂载）后重载。 */

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiCreateDir, apiList, apiRemove, apiRename, apiReveal, apiWrite } from '../api.ts'
import type { FsEntry } from '../../core/types.ts'

interface FileTreeProps {
  root: string
  /** 外部 fs 变更计数器：变化时轻量重载（保留展开），不重挂载组件。 */
  treeTick?: number
  onOpenFile: (path: string) => void
}

const FILE_ICON_COLOR = '#6b7280'
const DIR_ICON_COLOR = '#d4a72c'

/** One directory level: entries or a load error. */
interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Inline editing state: creating inside a dir, or renaming an existing row. */
type EditState =
  | { mode: 'new-file' | 'new-dir'; parent: string }
  | { mode: 'rename'; path: string; name: string }
  | null

/** The shared context menu: target row + cursor position. */
interface MenuState {
  path: string
  isDir: boolean
  x: number
  y: number
}

type MenuItem = { id: string; label: string; danger?: boolean } | 'sep'

/** Copy text to the clipboard (with a legacy execCommand fallback). */
async function writeClipboard(text: string): Promise<boolean> {
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

/** Absolute path (Windows backslash) for copy / reveal in explorer. */
function absolutePath(root: string, rel: string): string {
  if (rel === '') return root
  return root.replace(/[\\/]+$/, '') + '\\' + rel.replaceAll('/', '\\')
}

/** Split a relative path into dir + basename. */
function splitRel(rel: string): { dir: string; name: string } {
  const index = rel.lastIndexOf('/')
  return index === -1 ? { dir: '', name: rel } : { dir: rel.slice(0, index), name: rel.slice(index + 1) }
}

function rowStyle(depth: number, extra?: React.CSSProperties): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '2px 4px',
    paddingLeft: 8 + depth * 14,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: 13,
    lineHeight: '22px',
    userSelect: 'none',
    ...extra,
  }
}

function hoverHandlers(background = 'var(--ide-hover, rgba(127,127,127,0.1))'): {
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void
  onMouseLeave: (event: React.MouseEvent<HTMLElement>) => void
} {
  return {
    onMouseEnter: (event) => { (event.currentTarget as HTMLElement).style.background = background },
    onMouseLeave: (event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' },
  }
}

function FileIcon({ entry }: { entry: FsEntry }): JSX.Element {
  return (
    <span style={{ color: entry.isDir ? DIR_ICON_COLOR : FILE_ICON_COLOR, marginRight: 6, fontSize: 12, width: 16, display: 'inline-block', textAlign: 'center' }}>
      {entry.isDir ? '📁' : '📄'}
    </span>
  )
}

/** Inline input row used for both "new file/dir" and "rename". */
function EditRow({
  depth,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  depth: number
  initial: string
  placeholder: string
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <div style={{ paddingLeft: 8 + depth * 14, paddingRight: 8, paddingTop: 1, paddingBottom: 1 }}>
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit(value)
          else if (event.key === 'Escape') onCancel()
        }}
        onBlur={onCancel}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontSize: 13,
          padding: '1px 6px',
          background: 'var(--dsw-alias-bg-base,#ffffff)',
          color: 'inherit',
          border: '1px solid var(--ide-accent,#4f8cff)',
          borderRadius: 3,
          outline: 'none',
        }}
      />
    </div>
  )
}

interface RenderOpts {
  dir: string
  depth: number
  data: Record<string, LevelData>
  expanded: Set<string>
  editing: EditState
  copied: string | null
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onContextMenu: (event: React.MouseEvent, path: string, isDir: boolean) => void
  onCommitEdit: (value: string) => void
  onCancelEdit: () => void
}

/** Recursively render one directory level (children of `dir`). */
function renderChildren(opts: RenderOpts): ReactNode {
  const { dir, depth, data, expanded, editing, copied } = opts
  const level = data[dir]
  if (level === undefined) {
    return <div style={{ ...rowStyle(depth + 1), color: '#9ca3af', cursor: 'default' }}>加载中…</div>
  }
  if (level.error !== undefined) {
    return <div style={{ ...rowStyle(depth + 1), color: '#dc2626', cursor: 'default' }}>⚠ {level.error}</div>
  }
  const children = level.entries ?? []
  const showingNew = editing !== null && editing.mode !== 'rename' && editing.parent === dir
  if (children.length === 0 && !showingNew) {
    return <div style={{ ...rowStyle(depth + 1), color: '#9ca3af', fontStyle: 'italic', cursor: 'default' }}>（空目录）</div>
  }
  const rows: ReactNode[] = children.map((child) => {
    if (editing?.mode === 'rename' && editing.path === child.path) {
      return (
        <EditRow
          key={child.path}
          depth={depth + 1}
          initial={editing.name}
          placeholder="新名称"
          onCommit={opts.onCommitEdit}
          onCancel={opts.onCancelEdit}
        />
      )
    }
    const isDir = child.isDir
    const isExpanded = isDir && expanded.has(child.path)
    return (
      <div key={child.path}>
        <div
          style={rowStyle(depth + 1)}
          onClick={() => { if (isDir) opts.onToggle(child.path); else opts.onOpenFile(child.path) }}
          onContextMenu={(event) => opts.onContextMenu(event, child.path, isDir)}
          {...hoverHandlers()}
          title={child.path}
        >
          <span style={{ width: 14, display: 'inline-block', textAlign: 'center', fontSize: 10, marginRight: 2 }}>
            {isDir ? (isExpanded ? '▾' : '▸') : ''}
          </span>
          <FileIcon entry={child} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{child.name}</span>
          {copied === child.path
            ? <span style={{ marginLeft: 'auto', color: '#16a34a', fontSize: 11 }}>已复制</span>
            : (!isDir && child.size > 0
                ? <span style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 11 }}>{child.size}</span>
                : null)}
        </div>
        {isExpanded && renderChildren({ ...opts, dir: child.path, depth: depth + 1 })}
      </div>
    )
  })
  if (showingNew) {
    rows.push(
      <EditRow
        key="__new__"
        depth={depth + 1}
        initial=""
        placeholder={editing.mode === 'new-file' ? '文件名' : '文件夹名'}
        onCommit={opts.onCommitEdit}
        onCancel={opts.onCancelEdit}
      />,
    )
  }
  return <div>{rows}</div>
}

function menuItemsFor(menu: MenuState): MenuItem[] {
  const createItems: MenuItem[] = menu.isDir
    ? [{ id: 'new-file', label: '新建文件' }, { id: 'new-dir', label: '新建文件夹' }]
    : []
  return [
    { id: 'reveal', label: '在资源管理器中显示' },
    { id: 'copy-abs', label: '复制路径' },
    { id: 'copy-rel', label: '复制相对路径' },
    'sep',
    ...createItems,
    'sep',
    { id: 'rename', label: '重命名' },
    { id: 'delete', label: '删除', danger: true },
  ]
}

export function FileTree({ root, treeTick = 0, onOpenFile }: FileTreeProps): JSX.Element {
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef(expanded)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editing, setEditing] = useState<EditState>(null)
  const [confirm, setConfirm] = useState<{ path: string; name: string; isDir: boolean } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const lastRoot = useRef('')
  /** P2-03：root 代际标记——切 root 后旧请求响应直接丢弃，防串树。 */
  const rootGen = useRef(0)

  const storeLevel = useCallback((path: string, level: LevelData): void => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string, force = false): void => {
    // 防重：已加载的目录不重复拉取（force 时强制重拉）
    if (!force && dataRef.current[dir] !== undefined) return
    // 非 force（首次展开）显示「加载中」；force（刷新）**保留旧数据**直到新数据到达——
    // 这是文件树不闪的关键：刷新时若清空再异步填充，列表会闪空白
    if (!force) storeLevel(dir, {})
    const gen = rootGen.current
    void apiList(root, dir).then((result) => {
      // P2-03：代际校验——切换 root 后旧响应作废。
      if (gen !== rootGen.current) return
      if (result.ok) storeLevel(dir, { entries: result.value.entries })
      else storeLevel(dir, { error: result.error.message })
    }).catch((cause: unknown) => {
      if (gen !== rootGen.current) return
      storeLevel(dir, { error: cause instanceof Error ? cause.message : String(cause) })
    })
  }, [root, storeLevel])

  /** 轻量刷新：force 重拉 root 与所有展开目录，**不清空缓存**（旧数据保持显示，
   *  新数据到达后逐目录替换 → 无空白闪烁）。VS Code Explorer 同款思路（模型保留 + 局部更新）。 */
  const refresh = useCallback((): void => {
    if (root === '') return
    loadDir('', true)
    for (const dir of expandedRef.current) loadDir(dir, true)
  }, [root, loadDir])

  // Root change (or external refresh tick) rebuilds the cache.
  // treeTick 变化 = 外部 fs 变更：保留展开状态，force 重拉（不清空 → 不闪）；
  // root 变化 = 换工作区：清空缓存与展开（换根理应整体替换）。
  useEffect(() => {
    if (root === '') {
      expandedRef.current = new Set()
      setExpanded(new Set())
      return
    }
    if (lastRoot.current !== root) {
      lastRoot.current = root
      rootGen.current += 1
      dataRef.current = {}
      setData({})
      expandedRef.current = new Set()
      setExpanded(new Set())
      loadDir('')
      return
    }
    refresh()
  }, [root, refresh, treeTick, loadDir])

  const toggle = useCallback((path: string): void => {
    if (dataRef.current[path] === undefined) loadDir(path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      expandedRef.current = next
      return next
    })
  }, [loadDir])

  const openMenu = useCallback((event: React.MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setEditing(null)
    setMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }, [])

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (menu === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('[data-ide-tree-menu]') !== null) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const runMenuAction = (id: string): void => {
    if (menu === null) return
    const target = menu
    setMenu(null)
    if (id === 'reveal') {
      void apiReveal(root, target.path)
    } else if (id === 'copy-abs' || id === 'copy-rel') {
      const text = id === 'copy-abs' ? absolutePath(root, target.path) : target.path
      void writeClipboard(text).then((ok) => {
        if (ok) {
          setCopied(target.path)
          window.setTimeout(() => setCopied((current) => current === target.path ? null : current), 1200)
        }
      })
    } else if (id === 'new-file' || id === 'new-dir') {
      setEditing({ mode: id === 'new-file' ? 'new-file' : 'new-dir', parent: target.path })
    } else if (id === 'rename') {
      setEditing({ mode: 'rename', path: target.path, name: splitRel(target.path).name })
    } else if (id === 'delete') {
      setConfirm({ path: target.path, name: splitRel(target.path).name, isDir: target.isDir })
    }
  }

  const commitEdit = (value: string): void => {
    if (editing === null) return
    const name = value.trim()
    if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      setEditing(null)
      return
    }
    if (editing.mode !== 'rename') {
      const parent = editing.parent
      const target = parent === '' ? name : `${parent}/${name}`
      if (editing.mode === 'new-file') {
        void apiWrite(root, target, '').then((result) => {
          if (result.ok) {
            onOpenFile(target)
            refresh()
          }
        })
      } else {
        void apiCreateDir(root, target).then(() => refresh())
      }
    } else {
      const { dir } = splitRel(editing.path)
      const target = dir === '' ? name : `${dir}/${name}`
      void apiRename(root, editing.path, target).then(() => refresh())
    }
    setEditing(null)
  }

  const doRemove = (): void => {
    if (confirm === null) return
    const target = confirm
    setConfirm(null)
    void apiRemove(root, target.path).then(() => refresh())
  }

  const rootLevel = data['']
  const rootName = root === '' ? '' : root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const menuTop = menu === null ? 0 : Math.max(4, Math.min(menu.y, window.innerHeight - 300))
  const menuLeft = menu === null ? 0 : Math.max(4, Math.min(menu.x, window.innerWidth - 210))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        padding: '8px 10px',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--ide-muted, #6b7280)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        borderBottom: '1px solid var(--ide-border, #e5e6eb)',
        flexShrink: 0,
      }}>
        {root === '' ? '工作区' : rootName}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {root === '' ? (
          <div style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>请先打开一个工作区会话</div>
        ) : (
          <>
            <div
              style={rowStyle(0, { fontWeight: 600 })}
              onClick={() => { /* 根行点击：无操作（VS Code 根不可折叠） */ }}
              onContextMenu={(event) => openMenu(event, '', true)}
              {...hoverHandlers()}
              title={root}
            >
              <span style={{ width: 14, display: 'inline-block', textAlign: 'center', fontSize: 10, marginRight: 2 }}>▾</span>
              <FileIcon entry={{ name: '', path: '', isDir: true, size: 0, mtime: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{rootName}</span>
              {copied === '' && <span style={{ marginLeft: 'auto', color: '#16a34a', fontSize: 11 }}>已复制</span>}
            </div>
            {/* 根目录的新建输入框由 renderChildren 统一渲染（dir='' 时 showingNew 分支），
                这里不再单独渲染，避免与 renderChildren 重复挂载两个 EditRow——
                第二个 focus 触发第一个 onBlur 取消，导致根目录无法新建文件/文件夹。 */}
            {renderChildren({
              dir: '',
              depth: 0,
              data,
              expanded,
              editing,
              copied,
              onToggle: toggle,
              onOpenFile,
              onContextMenu: openMenu,
              onCommitEdit: commitEdit,
              onCancelEdit: () => setEditing(null),
            })}
          </>
        )}
      </div>

      {/* 右键菜单（portal 到 body，避免树容器 overflow 裁剪）。
          皮肤把 --dsw-alias-bg-base 全局透明化，浮层必须自足背景：
          overlay 是皮肤专为浮层准备的近不透明层变量（暗色深蓝 / 亮色近白），
          label-primary 提供对应文字色（暗色浅字，可读性要求）。 */}
      {menu !== null && createPortal(
        <div
          data-ide-tree-menu=""
          style={{
            position: 'fixed',
            left: menuLeft,
            top: menuTop,
            zIndex: 2147483000,
            minWidth: 190,
            padding: '4px 0',
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.96))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-border,#e5e6eb)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            fontSize: 13,
            fontFamily: 'inherit',
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menuItemsFor(menu).map((item, index) => {
            if (item === 'sep') {
              return <div key={`sep${index}`} style={{ height: 1, margin: '4px 0', background: 'var(--ide-border,#e5e6eb)' }} />
            }
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => runMenuAction(item.id)}
                {...hoverHandlers('var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))')}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 14px',
                  border: 'none',
                  background: 'transparent',
                  color: item.danger === true ? '#dc2626' : 'inherit',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {item.label}
              </button>
            )
          })}
        </div>,
        document.body,
      )}

      {/* 删除确认浮层 */}
      {confirm !== null && createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.35)',
          }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirm(null) }}
        >
          <div style={{
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.96))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-border,#e5e6eb)',
            borderRadius: 8,
            padding: 16,
            width: 320,
            boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>确认删除</div>
            <div style={{ fontSize: 13, color: 'var(--ide-muted,#6b7280)', marginBottom: 14, wordBreak: 'break-all' }}>
              {confirm.name}
              {confirm.isDir ? '（目录，将递归删除）' : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                style={{
                  padding: '4px 14px',
                  border: '1px solid var(--ide-border,#e5e6eb)',
                  borderRadius: 4,
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={doRemove}
                style={{
                  padding: '4px 14px',
                  border: 'none',
                  borderRadius: 4,
                  background: '#dc2626',
                  color: '#ffffff',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
