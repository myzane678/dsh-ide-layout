/** Center column: multi-tab editor with open/edit/save. CodeMirror 6 adds
 * syntax highlighting, line numbers, bracket matching and code folding
 * (replacing the MVP textarea). */

import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { basicSetup } from 'codemirror'
import { EditorView, hoverTooltip, keymap, type Tooltip } from '@codemirror/view'
import { Prec, type Extension, type Text } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { autocompletion, acceptCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { apiRead, apiRun, apiWrite } from '../api.ts'
import type { RunResult } from '../api.ts'
import type { EditorTab } from '../store.ts'
import { languageIdForPath } from '../../core/types.ts'
import {
  LspClient, completionInfo, completionType, normalizeUri, pathToUri,
  type LspDiagnostic, type LspLocation, type LspPosition, type LspRange, type LspTextEdit,
} from '../lsp-client.ts'
import { TerminalPane } from './TerminalPane.tsx'

interface EditorPaneProps {
  root: string
  tabs: EditorTab[]
  activeTabId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onContentChange: (id: string, content: string) => void
  onDirtySave: (tab: EditorTab) => void
  onCloseEditor: () => void
  /** 把选中代码交给内置 agent（追加到聊天输入框）。 */
  onAskAgent: (text: string, path: string) => void
  /** 打开一个文件（相对路径），可选定位到指定行（0-based）。 */
  onOpenFile: (path: string, line?: number) => void
  /** LSP 诊断推送上抛（写入 IdeState.diagnostics，供问题面板聚合）。 */
  onDiagnostics: (uri: string, diagnostics: LspDiagnostic[]) => void
}

/** Pick a CodeMirror language by file extension. */
function languageFor(path: string): Extension {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'ts': return javascript({ typescript: true })
    case 'tsx': case 'mts': case 'cts': return javascript({ typescript: true, jsx: true })
    case 'json': case 'jsonc': case 'map': return json()
    case 'md': case 'markdown': return markdown()
    case 'py': return python()
    case 'html': case 'htm': return html()
    case 'css': return css()
    default: return []
  }
}

/** 高对比高亮：经典 IDE 配色（关键字深蓝加粗 / 注释绿斜体 / 字符串深红 / 数字深绿），
 *  让各语法元素一眼可分。颜色用 CSS 变量承载：默认亮色系（浅背景），
 *  皮肤（如 maid-atelier）可在自己的 CSS 里按亮/暗主题覆盖变量适配深背景。 */
const ideHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--ide-hl-keyword, #0000FF)', fontWeight: '600' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--ide-hl-comment, #008000)', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--ide-hl-string, #A31515)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--ide-hl-number, #098658)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--ide-hl-bool, #0000FF)' },
  { tag: [t.function(t.variableName), t.definition(t.function(t.variableName))], color: 'var(--ide-hl-function, #795E26)' },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: 'var(--ide-hl-class, #267F99)' },
  { tag: [t.propertyName], color: 'var(--ide-hl-property, #0070C1)' },
  { tag: [t.definition(t.variableName)], color: 'var(--ide-hl-variable, #001080)' },
  { tag: t.invalid, color: 'var(--ide-hl-invalid, #FF0000)' },
])

interface CodeMirrorPaneProps {
  tab: EditorTab
  onContentChange: (id: string, content: string) => void
  onSave: (tab: EditorTab) => void
  /** 编辑器内右键菜单回调（选中文本非空时触发）。 */
  onContextAction: (kind: 'ask-agent' | 'copy', text: string) => void
  /** LSP 客户端（当前 root 一个，可为 null = 未启用）。 */
  lsp: LspClient | null
  /** 当前文件的最新 LSP 诊断（EditorPane 层按 uri 缓存）。 */
  diagnostics: LspDiagnostic[]
  /** 跳转定义：把目标文件（相对路径 + 行）交给 EditorPane 打开。 */
  onOpenLocation: (path: string, line: number) => void
  /** 打开本文件后要定位到的行（0-based；null = 不定位）。 */
  revealLine: number | null
  /** 定位完成后清空 revealLine。 */
  onRevealDone: () => void
  /** 工作区根目录（用于 uri 归一化匹配 / 跨文件写盘）。 */
  root: string
  /** 光标位置变化回调（状态栏行列显示）。 */
  onCursor?: (line: number, column: number) => void
}

/** LSP 0-based {line, character} → CodeMirror 文档 offset。 */
function lspPosToOffset(doc: Text, pos: LspPosition): number {
  const line = doc.line(pos.line + 1)
  return Math.min(line.from + Math.max(0, pos.character), line.to)
}

/** LSP Diagnostic → CodeMirror linter Diagnostic（offset 表示）。 */
function toCmDiagnostic(doc: Text, diagnostic: LspDiagnostic): Diagnostic {
  let severity: 'error' | 'warning' | 'info' = 'error'
  if (diagnostic.severity === 2) severity = 'warning'
  else if (diagnostic.severity === 3 || diagnostic.severity === 4) severity = 'info'
  return {
    from: lspPosToOffset(doc, diagnostic.range.start),
    to: lspPosToOffset(doc, diagnostic.range.end),
    severity,
    message: diagnostic.message,
  }
}

/** 补全触发前最宽（保守）的单词匹配：从当前光标往前取标识符字符。 */
function matchWordAt(context: CompletionContext): { from: number; text: string } | null {
  const match = context.matchBefore(/[\w$]+/)
  if (match === null) return null
  return { from: match.from, text: match.text }
}

/** 把 LSP hover 的 contents（MarkupContent / MarkedString[]）渲染成 tooltip DOM。
 *  纯文本直接换行；含代码块（```lang）时按 code 渲染。
 *  滚轮优先悬停栏：内容可滚动时 wheel 由 tooltip 自己消费（不冒泡给页面），
 *  滚到边界后停止——页面不会跟着滚。 */
function renderHoverDom(contents: unknown): HTMLElement {
  const container = document.createElement('div')
  // 皮肤会把 --dsw-alias-bg-base 全局透明化：tooltip 浮层必须自带不透明背景
  // + 文字色 + 边框，否则透出底下代码看不清。
  container.style.cssText = [
    'max-width: 480px', 'max-height: 320px', 'overflow: auto',
    'font-size: 13px', 'line-height: 1.5',
    'padding: 8px 10px', 'border-radius: 6px',
    'background: var(--dsw-alias-bg-overlay, rgba(248,250,255,0.98))',
    'color: var(--dsw-alias-label-primary, #1a1a1a)',
    'border: 1px solid var(--ide-border, #e5e6eb)',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.28)',
  ].join('; ')
  // 滚轮优先：tooltip 内可滚动时接管 wheel；到边界后 stopPropagation（页面不动）。
  container.addEventListener('wheel', (event) => {
    const { scrollTop, scrollHeight, clientHeight } = container
    const canScroll = scrollHeight > clientHeight
    if (!canScroll) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const atTop = scrollTop <= 0
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1
    // 方向朝外（顶部再往上滚 / 底部再往下滚）时不滚，但也吞掉事件（页面不动）。
    if (!(atTop && event.deltaY < 0) && !(atBottom && event.deltaY > 0)) {
      container.scrollTop += event.deltaY
    }
  }, { passive: false })
  const parts: Array<{ text: string; code: boolean; language?: string }> = []
  const pushString = (text: string): void => {
    // 拆出 ```lang ... ``` 代码块，其余按纯文本。
    const regex = /```([\w+-]*)\n?([\s\S]*?)```/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) parts.push({ text: text.slice(last, match.index), code: false })
      parts.push({ text: match[2].trimEnd(), code: true, language: match[1] })
      last = match.index + match[0].length
    }
    if (last < text.length) parts.push({ text: text.slice(last), code: false })
  }
  const value = contents as unknown
  if (typeof value === 'string') {
    pushString(value)
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') pushString(item)
      else if (item !== null && typeof item === 'object') pushString(String((item as { value?: unknown }).value ?? ''))
    }
  } else if (value !== null && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    pushString(String((value as Record<string, unknown>).value))
  }
  for (const part of parts) {
    const el = document.createElement(part.code ? 'pre' : 'div')
    el.style.cssText = part.code
      ? 'margin: 2px 0; padding: 4px 6px; border-radius: 4px; background: rgba(127,127,127,0.12); font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word;'
      : 'margin: 1px 0; white-space: pre-wrap; word-break: break-word;'
    el.textContent = part.text
    container.appendChild(el)
  }
  return container
}

/** 从 CodeMirror 状态里把 LSP hover 范围转成 tooltip 的 pos/end（可选）。
 *  注意：client 必须从 propsRef 读取（LSP 连接是异步建立的，mount 时可能
 *  还是 null；用闭包捕获会永远拿到 null → 悬停不工作）。 */
function hoverTooltipFor(
  getClient: () => LspClient | null,
  path: () => string,
): (view: EditorView, pos: number) => Promise<Tooltip | null> {
  return async (view, pos) => {
    const client = getClient()
    if (client === null) return null
    const position: LspPosition = {
      line: view.state.doc.lineAt(pos).number - 1,
      character: pos - view.state.doc.lineAt(pos).from,
    }
    const hover = await client.hover(path(), position)
    if (hover === null) return null
    return {
      pos,
      create: () => ({ dom: renderHoverDom(hover.contents) }),
    }
  }
}

/** 当前 CodeMirrorPane 的跳转定义回调（F12 / Ctrl+点击共用）。 */
interface JumpProps {
  lsp: LspClient | null
  tab: EditorTab
  root: string
  onOpenLocation: (path: string, line: number) => void
  onContentChange: (id: string, content: string) => void
}

/** F12 / Ctrl+点击 → 请求 textDocument/definition，把首个定位交给 EditorPane。 */
function jumpToDefinition(view: EditorView, props: JumpProps): boolean {
  const client = props.lsp
  if (client === null) return false
  const cursor = view.state.selection.main.head
  const position: LspPosition = {
    line: view.state.doc.lineAt(cursor).number - 1,
    character: cursor - view.state.doc.lineAt(cursor).from,
  }
  void client.definition(props.tab.path, position).then((locations) => {
    if (locations.length === 0) return
    const first = locations[0]
    props.onOpenLocation(first.uri, first.range.start.line)
  }).catch(() => { /* 忽略：定义不可达时静默 */ })
  return true
}

/** 菜单按钮统一样式（与皮肤 overlay 变量配套）。 */
function menuItemStyle(): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left', padding: '5px 14px',
    border: 'none', background: 'transparent', color: 'inherit',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  }
}

/** 取光标所在处的标识符单词（向前向后扩展 [\w$]）。 */
function wordAt(view: EditorView, pos: number): string | null {
  const doc = view.state.doc
  const line = doc.lineAt(pos)
  const before = doc.sliceString(line.from, pos)
  const after = doc.sliceString(pos, line.to)
  const head = /[\w$]*$/.exec(before)?.[0] ?? ''
  const tail = /^[\w$]*/.exec(after)?.[0] ?? ''
  const word = head + tail
  return word === '' ? null : word
}

/** offset → LSP 0-based position。 */
function offsetToLsp(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset)
  return { line: line.number - 1, character: offset - line.from }
}

/** 把 WorkspaceEdit 应用到编辑器：当前文件的 edits 走 view.dispatch（倒序防偏移），
 *  其他文件的 edits 直接写盘（apiWrite，root 内路径）。返回受影响文件数。 */
async function applyWorkspaceEdit(
  view: EditorView,
  props: JumpProps,
  edit: { changes?: Record<string, LspTextEdit[]>; documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }> },
): Promise<number> {
  const changes = edit.documentChanges ?? Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ textDocument: { uri }, edits }))
  const ownUri = normalizeUri(pathToUri(props.root, props.tab.path))
  let touched = 0
  for (const change of changes) {
    const uri = normalizeUri(change.textDocument.uri)
    if (uri === ownUri) {
      // 当前文件：编辑器内应用（倒序，从后往前避免位置漂移）。
      const sorted = [...change.edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)
      let applied = false
      for (const textEdit of sorted) {
        const from = lspPosToOffset(view.state.doc, textEdit.range.start)
        const to = lspPosToOffset(view.state.doc, textEdit.range.end)
        view.dispatch({ changes: { from, to, insert: textEdit.newText } })
        applied = true
      }
      if (applied) props.onContentChange(props.tab.id, view.state.doc.toString())
      touched += 1
    } else if (props.root !== '') {
      // 其他文件：read → 应用 edits → write 回盘。
      const decoded = normalizeUri(uri).replace(/^file:\/\//, '').replace(/^\//, '')
      const rootUri = normalizeUri(pathToUri(props.root, '')).replace(/^file:\/\//, '').replace(/^\//, '')
      const rel = decoded.toLowerCase().startsWith(rootUri.toLowerCase())
        ? decoded.slice(rootUri.length).replace(/^[\\/]/, '')
        : null
      if (rel === null || rel === '') continue
      const read = await apiRead(props.root, rel)
      if (!read.ok) continue
      const sorted = [...change.edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)
      let content = read.value.content
      const lines = content.split('\n')
      for (const textEdit of sorted) {
        const start = offsetFromLines(lines, textEdit.range.start)
        const end = offsetFromLines(lines, textEdit.range.end)
        if (start === -1 || end === -1) continue
        content = content.slice(0, start) + textEdit.newText + content.slice(end)
        lines.splice(0, lines.length, ...content.split('\n'))
      }
      await apiWrite(props.root, rel, content)
      touched += 1
    }
  }
  return touched
}

/** 由行列表计算 (line, char) 的字符偏移。 */
function offsetFromLines(lines: string[], pos: LspPosition): number {
  if (pos.line < 0 || pos.line >= lines.length) return -1
  let offset = 0
  for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1
  return offset + Math.min(pos.character, lines[pos.line].length)
}

/** 重命名：请求 LSP rename，应用 WorkspaceEdit。 */
async function doRename(view: EditorView, props: JumpProps, newName: string): Promise<void> {
  const client = props.lsp
  if (client === null) return
  const cursor = view.state.selection.main.head
  const edit = await client.rename(props.tab.path, offsetToLsp(view.state.doc, cursor), newName)
  if (edit === null) return
  await applyWorkspaceEdit(view, props, edit)
}

/** 格式化：请求 LSP formatting，把 TextEdit[] 应用到当前文档。 */
async function formatDocument(view: EditorView, props: JumpProps): Promise<void> {
  const client = props.lsp
  if (client === null) return
  const edits = await client.formatting(props.tab.path)
  if (edits.length === 0) return
  const sorted = [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)
  // 倒序逐条 dispatch：每条都基于最新 doc，位置不漂移。
  for (const textEdit of sorted) {
    const from = lspPosToOffset(view.state.doc, textEdit.range.start)
    const to = lspPosToOffset(view.state.doc, textEdit.range.end)
    view.dispatch({ changes: { from, to, insert: textEdit.newText } })
  }
  props.onContentChange(props.tab.id, view.state.doc.toString())
}

/** 快速修复：请求光标处 codeAction，返回菜单项列表（apply 回调已绑定）。 */
async function codeActionsFor(
  view: EditorView,
  props: JumpProps,
  cursor: number,
): Promise<Array<{ title: string; apply: () => void }>> {
  const client = props.lsp
  if (client === null) return []
  const line = view.state.doc.lineAt(cursor)
  const range: LspRange = { start: { line: line.number - 1, character: 0 }, end: { line: line.number - 1, character: line.length } }
  const actions = await client.codeAction(props.tab.path, range)
  return actions.map((action) => ({
    title: action.title,
    apply: () => {
      if (action.edit !== undefined) {
        void applyWorkspaceEdit(view, props, action.edit)
      }
      // command 类修复（如 organize imports 的 executeCommand）暂不支持。
    },
  }))
}

/** One CodeMirror instance per tab. The parent remounts this component via
 * `key={tab.id}` on tab switch; the view is created once on mount and
 * destroyed on unmount (non-controlled: doc flows out via updateListener). */
function CodeMirrorPane({ tab, onContentChange, onSave, onContextAction, lsp, diagnostics, onOpenLocation, revealLine, onRevealDone, root, onCursor }: CodeMirrorPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 右键菜单：无选中时也弹出（重命名/格式化/快速修复）；text 为空表示无选中。
  const [menu, setMenu] = useState<{ text: string; x: number; y: number } | null>(null)
  // 快速修复子菜单（光标处 codeAction 列表）
  const [actions, setActions] = useState<{ items: Array<{ title: string; apply: () => void }>; x: number; y: number } | null>(null)
  // 重命名输入框
  const [renameBox, setRenameBox] = useState<{ x: number; y: number; initial: string } | null>(null)
  // Latest props for the mount-time closures (keymap / updateListener / LSP).
  const propsRef = useRef({ tab, onContentChange, onSave, lsp, diagnostics, onOpenLocation, revealLine, onRevealDone, root, onCursor })
  propsRef.current = { tab, onContentChange, onSave, lsp, diagnostics, onOpenLocation, revealLine, onRevealDone, root, onCursor }

  useEffect(() => {
    // LSP 扩展是否安装只看文件类型（语言是否支持），不依赖 lsp 是否已就绪——
    // LSP 连接异步建立，mount 时可能还是 null；扩展先装上，source 内部
    // 通过 propsRef 读最新 lsp（就绪后自动生效）。
    const lspEnabled = languageIdForPath(propsRef.current.tab.path) !== null
    const view = new EditorView({
      doc: propsRef.current.tab.content,
      extensions: [
        basicSetup,
        languageFor(propsRef.current.tab.path),
        // 注意：不能带 { fallback: true } —— 那会让语言自带高亮器（lang-* 的默认配色）优先，
        // 自定义配色完全失效；不带 fallback 时本高亮器与语言高亮并列，注册靠后 CSS 优先
        syntaxHighlighting(ideHighlight),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            height: '100%', fontSize: '13px',
            backgroundColor: 'var(--dsw-alias-bg-base, #ffffff)',
            color: 'inherit',
          },
          '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.6' },
          '.cm-gutters': {
            backgroundColor: 'var(--dsw-alias-bg-base, #ffffff)',
            borderRight: '1px solid rgba(127,127,127,0.2)',
            color: '#9ca3af',
          },
          '.cm-activeLine': { backgroundColor: 'rgba(127,127,127,0.08)' },
          '.cm-activeLineGutter': { backgroundColor: 'rgba(127,127,127,0.08)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'rgba(64,128,255,0.2)',
          },
          '&.cm-focused': { outline: 'none' },
        }),
        Prec.highest(keymap.of([
          {
            key: 'Mod-s',
            run: () => { propsRef.current.onSave(propsRef.current.tab); return true },
          },
          // VS Code 习惯：Tab 接受补全（补全未打开时返回 false → 放行默认缩进）。
          {
            key: 'Tab',
            run: (view) => acceptCompletion(view),
          },
          // F12：跳转定义。
          {
            key: 'F12',
            run: (view) => jumpToDefinition(view, propsRef.current),
          },
          // F2：重命名符号（LSP textDocument/rename）。
          {
            key: 'F2',
            run: (view) => {
              const word = wordAt(view, view.state.selection.main.head)
              const rect = view.coordsAtPos(view.state.selection.main.head)
              setRenameBox({
                x: rect !== null ? rect.left : view.dom.getBoundingClientRect().left + 40,
                y: rect !== null ? rect.bottom + 4 : view.dom.getBoundingClientRect().top + 40,
                initial: word ?? '',
              })
              return true
            },
          },
          // Shift+Alt+F：格式化文档（LSP textDocument/formatting）。
          {
            key: 'Shift-Alt-f',
            run: (view) => { void formatDocument(view, propsRef.current); return true },
          },
        ])),
        // 悬停提示（hover）：鼠标悬停在标识符上显示类型/文档（纯 LSP 请求）。
        ...(lspEnabled ? [hoverTooltip(
          hoverTooltipFor(() => propsRef.current.lsp, () => propsRef.current.tab.path),
          { hoverTime: 350 },
        )] : []),
        // Ctrl/Cmd + 点击 → 跳转定义（VS Code 习惯）。
        ...(lspEnabled ? [EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!(event.ctrlKey || event.metaKey)) return false
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos === null) return false
            event.preventDefault()
            jumpToDefinition(view, propsRef.current)
            return true
          },
        })] : []),
        // LSP 补全：override 数组替换语言包自带的本地补全源（由 tsserver 接管）。
        ...(lspEnabled ? [autocompletion({
          override: [(context: CompletionContext): Promise<CompletionResult | null> | null => {
            const client = propsRef.current.lsp
            if (client === null) return null
            const path = propsRef.current.tab.path
            const position: LspPosition = {
              line: context.state.doc.lineAt(context.pos).number - 1,
              character: context.pos - context.state.doc.lineAt(context.pos).from,
            }
            return client.completion(path, position).then((items) => {
              if (items === null) return null
              const word = matchWordAt(context)
              return {
                from: word !== null ? word.from : context.pos,
                options: items.map((item) => ({
                  label: item.label,
                  type: completionType(item.kind),
                  detail: item.detail,
                  info: completionInfo(item.documentation),
                  apply: item.textEdit?.newText ?? item.insertText ?? item.label,
                  boost: item.sortText !== undefined ? 0 : 1,
                })),
              }
            })
          }],
        })] : []),
        // LSP 诊断：linter source 从 propsRef 拿最新缓存诊断（EditorPane 收到
        // publishDiagnostics 后 setState → 本组件重渲染 → forceLinting 刷新）。
        ...(lspEnabled ? [linter((view) => propsRef.current.diagnostics.map((d) => toCmDiagnostic(view.state.doc, d)))] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const content = update.state.doc.toString()
            propsRef.current.onContentChange(propsRef.current.tab.id, content)
            // 同步全量文本给 LSP（didChange，版本号内部递增）。
            propsRef.current.lsp?.updateDocument(propsRef.current.tab.path, content)
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            propsRef.current.onCursor?.(line.number, head - line.from + 1)
          }
        }),
      ],
      parent: hostRef.current!,
    })
    viewRef.current = view
    // 文档生命周期：didOpen（挂载时）+ didClose（卸载时）。切 tab 时组件以
    // key=tab.id 重建，旧实例卸载 → didClose，新实例挂载 → didOpen。
    propsRef.current.lsp?.openDocument(propsRef.current.tab.path, propsRef.current.tab.content)
    return () => {
      viewRef.current = null
      propsRef.current.lsp?.closeDocument(propsRef.current.tab.path)
      view.destroy()
    }
    // 组件以 key=tab.id 重建，effect 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // LSP 会话在 EditorPane 渲染后才建立（root effect），挂载时 lsp 可能还是
  // null；这里单独监听：lsp 就绪（或 root 变化重建）时把当前文档登记给服务器。
  // openDocument 幂等：docs 已有记录时仅更新文本缓存，不重复 didOpen。
  useEffect(() => {
    if (lsp === null) return
    lsp.openDocument(tab.path, tab.content)
  }, [lsp, tab.path, tab.content])

  // 收到新诊断 → 强制 lint 重跑（linter source 读最新 props）。
  useEffect(() => {
    const view = viewRef.current
    if (view !== null && lsp !== null) forceLinting(view)
  }, [diagnostics, lsp])

  // 跳转定义后定位：本文件已打开时，revealLine 变化 → 光标跳到目标行并滚动到视口。
  useEffect(() => {
    if (revealLine === null) return
    const view = viewRef.current
    if (view === null) return
    const lineNumber = Math.max(0, revealLine)
    const line = view.state.doc.line(Math.min(lineNumber + 1, view.state.doc.lines))
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
    view.focus()
    onRevealDone()
  }, [revealLine, onRevealDone])

  // 关闭浮层（右键菜单 / 快速修复子菜单 / 重命名框：外部点击或 Esc）
  useEffect(() => {
    if (menu === null && actions === null && renameBox === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('[data-ide-editor-menu], [data-ide-rename-box]') !== null) return
      setMenu(null)
      setActions(null)
      setRenameBox(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenu(null)
      setActions(null)
      setRenameBox(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, actions, renameBox])

  return (
    <>
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        onContextMenu={(event) => {
          const view = viewRef.current
          if (view === null) return
          event.preventDefault()
          const selection = view.state.selection.main
          const text = view.state.sliceDoc(selection.from, selection.to)
          setMenu({ text, x: event.clientX, y: event.clientY })
        }}
      />
      {menu !== null && createPortal(
        <div
          data-ide-editor-menu=""
          style={{
            position: 'fixed', left: Math.max(4, Math.min(menu.x, window.innerWidth - 220)),
            top: Math.max(4, Math.min(menu.y, window.innerHeight - 120)),
            zIndex: 1000, minWidth: 200, padding: '4px 0',
            // 皮肤把 --dsw-alias-bg-base 全局透明化，浮层用 overlay（近不透明层变量）
            // + label-primary（文字色）自足背景，避免透明菜单透出底下内容看不清。
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.96))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontSize: 13, fontFamily: 'inherit',
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              const view = viewRef.current
              const m = menu
              setMenu(null)
              if (view === null || m === null) return
              const cursor = view.state.selection.main.head
              void codeActionsFor(view, propsRef.current, cursor).then((items) => {
                if (items.length > 0) setActions({ items, x: m.x, y: m.y })
              })
            }}
            style={menuItemStyle()}
          >
            💡 快速修复
          </button>
          <button
            type="button"
            onClick={() => {
              const view = viewRef.current
              const m = menu
              setMenu(null)
              if (view === null || m === null) return
              const cursor = view.state.selection.main.head
              const word = wordAt(view, cursor)
              setRenameBox({ x: m.x, y: m.y, initial: word ?? '' })
            }}
            style={menuItemStyle()}
          >
            ✏️ 重命名符号 (F2)
          </button>
          <button
            type="button"
            onClick={() => {
              const view = viewRef.current
              setMenu(null)
              if (view === null) return
              void formatDocument(view, propsRef.current)
            }}
            style={menuItemStyle()}
          >
            🎨 格式化文档 (Shift+Alt+F)
          </button>
          <div style={{ height: 1, margin: '4px 8px', background: 'var(--ide-border,#e5e6eb)' }} />
          {menu.text.trim() !== '' && (
            <button
              type="button"
              onClick={() => { const m = menu; setMenu(null); if (m !== null) onContextAction('ask-agent', m.text) }}
              style={menuItemStyle()}
            >
              🤖 发送给 agent 分析/修改
            </button>
          )}
          {menu.text.trim() !== '' && (
            <button
              type="button"
              onClick={() => { const m = menu; setMenu(null); if (m !== null) onContextAction('copy', m.text) }}
              style={menuItemStyle()}
            >
              📋 复制选中
            </button>
          )}
        </div>,
        document.body,
      )}
      {/* 快速修复子菜单（codeAction 列表） */}
      {actions !== null && createPortal(
        <div
          data-ide-editor-menu=""
          style={{
            position: 'fixed', left: Math.max(4, Math.min(actions.x, window.innerWidth - 260)),
            top: Math.max(4, Math.min(actions.y, window.innerHeight - 160)),
            zIndex: 1001, minWidth: 240, padding: '4px 0',
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.98))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontSize: 13, fontFamily: 'inherit',
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div style={{ padding: '4px 14px', fontSize: 11, color: '#9ca3af' }}>快速修复</div>
          {actions.items.map((item) => (
            <button
              key={item.title}
              type="button"
              onClick={() => { setActions(null); item.apply() }}
              style={menuItemStyle()}
            >
              {item.title}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {/* 重命名输入框 */}
      {renameBox !== null && createPortal(
        <div
          data-ide-rename-box=""
          style={{
            position: 'fixed', left: Math.max(4, Math.min(renameBox.x, window.innerWidth - 260)),
            top: Math.max(4, Math.min(renameBox.y, window.innerHeight - 80)),
            zIndex: 1001, width: 240, padding: '6px 10px',
            background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.98))',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--ide-accent,#4f8cff)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontSize: 13, fontFamily: 'inherit',
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>重命名符号</div>
          <input
            autoFocus
            defaultValue={renameBox.initial}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '4px 6px',
              fontSize: 13, fontFamily: 'inherit', outline: 'none',
              background: 'var(--dsw-alias-bg-base,#ffffff)', color: 'inherit',
              border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 4,
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setRenameBox(null); return }
              if (event.key !== 'Enter') return
              const value = (event.currentTarget as HTMLInputElement).value.trim()
              const box = renameBox
              setRenameBox(null)
              const view = viewRef.current
              if (box === null || view === null || value === '') return
              void doRename(view, propsRef.current, value)
            }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}

function tabTitle(path: string): string {
  return path.split('/').pop() ?? path
}

/** 运行面板状态：进行中 或 完成（含输出与退出码）。 */
type RunOutput =
  | { state: 'running' }
  | { state: 'done'; result: RunResult; error?: string }

const EMPTY_RUN: RunResult = {
  exitCode: null,
  signal: null,
  timedOut: false,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 0,
}

/** 复制到剪贴板（含旧引擎 fallback），供「复制选中」使用。 */
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

/**
 * 面板拖拽手柄的 pointerdown 处理（终端 / 输出面板共用）：
 * - **拖拽中直接操作 DOM 高度（target.style.height），不触发 React 重渲染**——
 *   这是消除「底部抖动」的关键：之前每帧 setState 让 React 重渲染整个 EditorPane
 *   （CodeMirror/终端/状态栏全树 layout），浏览器布局每帧重排 → 面板边框抖动。
 * - setPointerCapture 锁定指针事件（拖出面板/窗口不丢事件）；向上拖 = 高度变大。
 * - 松手：onCommit(最终 px) 同步回 React 状态（供持久化），onDragEnd 回调一次
 *   （终端用它触发「立即 fit」）。
 */
function beginDragResize(
  event: React.PointerEvent<HTMLElement>,
  min: number,
  max: number,
  onCommit: (px: number) => void,
  onDragEnd?: () => void,
): void {
  event.preventDefault()
  const el = event.currentTarget
  // 手柄的父元素 = 面板容器（终端 / 输出），拖拽时直接改它的高度
  const target = el.parentElement
  if (target === null) return
  let captured = false
  try {
    el.setPointerCapture(event.pointerId)
    captured = true
  } catch {
    // 某些环境（如触摸）捕获可能失败；退化为 window 监听。
  }
  const startY = event.clientY
  const startHeight = target.getBoundingClientRect().height
  const onMove = (moveEvent: PointerEvent): void => {
    const next = Math.max(min, Math.min(startHeight + (startY - moveEvent.clientY), max))
    // 原生 DOM 直改：无 React 重渲染、无整树布局抖动
    target.style.height = `${next}px`
  }
  const onEnd = (): void => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onEnd)
    el.removeEventListener('pointercancel', onEnd)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    try {
      el.releasePointerCapture(event.pointerId)
    } catch {
      // capture 可能已自动释放
    }
    // 同步最终高度到 React 状态（此时 DOM 已是最终值，状态对齐后无跳变）
    onCommit(target.getBoundingClientRect().height)
    onDragEnd?.()
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onEnd)
  el.addEventListener('pointercancel', onEnd)
  if (!captured) {
    // capture 失败时兜底：指针拖出元素后，window 层仍能收到松手事件
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }
}

/** 面板顶部拖拽手柄的通用渲染（内联样式）。 */
function resizeHandleStyle(): React.CSSProperties {
  return {
    position: 'absolute',
    top: -4,
    left: 0,
    right: 0,
    height: 8,
    cursor: 'ns-resize',
    zIndex: 10,
    background: 'transparent',
  }
}

export function EditorPane({
  root, tabs, activeTabId, onActivate, onClose, onContentChange, onDirtySave, onCloseEditor, onAskAgent, onOpenFile, onDiagnostics,
}: EditorPaneProps): JSX.Element {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const [status, setStatus] = useState('')
  const [output, setOutput] = useState<RunOutput | null>(null)
  const [termVisible, setTermVisible] = useState(false)
  // 终端面板高度（px），顶部手柄可拖拽调整
  const [termHeight, setTermHeight] = useState(240)
  // 运行输出面板高度（px），同样可拖拽
  const [outputHeight, setOutputHeight] = useState(200)
  // 终端「立即 fit」触发器：手柄松手时 +1，TerminalPane 跳过防抖立即 fit+resize
  const [termFitTick, setTermFitTick] = useState(0)
  // LSP：每 root 两个语言服务器客户端（ts = typescript-language-server，
  // py = pyright），按当前文件类型选用；诊断按 uri 缓存（共享一个 map）。
  const [tsLsp, setTsLsp] = useState<LspClient | null>(null)
  const [pyLsp, setPyLsp] = useState<LspClient | null>(null)
  const [diagMap, setDiagMap] = useState<Map<string, LspDiagnostic[]>>(new Map())
  const [lspStatus, setLspStatus] = useState('')
  // 状态栏：光标行列
  const [cursorPos, setCursorPos] = useState<{ line: number; column: number } | null>(null)

  // 当前文件的 LSP 客户端：python → py，其余 → ts。
  const lspFor = (path: string): LspClient | null => {
    const language = languageIdForPath(path)
    return language === 'python' ? pyLsp : tsLsp
  }

  // 每 root 两个 LSP 会话：root 变化时重建（旧实例 dispose）。
  useEffect(() => {
    if (root === '') {
      setTsLsp(null)
      setPyLsp(null)
      setDiagMap(new Map())
      return
    }
    const makeClient = (server: 'ts' | 'py'): LspClient => new LspClient({
      root,
      rootUri: pathToUri(root, ''),
      server,
      onDiagnostics: (uri, diagnostics) => {
        // 本地缓存（编辑器波浪线）+ 上抛（问题面板聚合）。
        setDiagMap((prev) => {
          const next = new Map(prev)
          next.set(uri, diagnostics)
          return next
        })
        onDiagnostics(uri, diagnostics)
      },
      onOpen: () => setLspStatus('已连接'),
      onFatal: (reason) => setLspStatus(`LSP 不可用: ${reason}`),
    })
    const ts = makeClient('ts')
    const py = makeClient('py')
    setTsLsp(ts)
    setPyLsp(py)
    setDiagMap(new Map())
    setLspStatus('连接中…')
    ts.connect()
    py.connect()
    return () => {
      ts.dispose()
      py.dispose()
      setTsLsp(null)
      setPyLsp(null)
    }
  }, [root])

  /** 跳转定义：LSP 返回的 uri（file:///...）→ 相对 root 路径 + 行号。
   *  目标文件已打开则直接定位；未打开则走 mount 层的 openFile。 */
  const [revealTarget, setRevealTarget] = useState<{ path: string; line: number } | null>(null)
  const onOpenLocation = (uri: string, line: number): void => {
    if (root === '') return
    const decoded = normalizeUri(uri).replace(/^file:\/\//, '')
    // 归一化后路径可能是 /c:/... 或 c:/...，去掉前导斜杠。
    const candidate = decoded.replace(/^\//, '').replaceAll('/', '\\')
    const normRoot = normalizeUri(pathToUri(root, '')).replace(/^file:\/\//, '').replace(/^\//, '').replaceAll('/', '\\').replace(/\\$/, '')
    const normCandidate = candidate.replace(/^[a-zA-Z]:/, (drive) => drive.toUpperCase())
    const normRootUpper = normRoot.replace(/^[a-zA-Z]:/, (drive) => drive.toUpperCase())
    if (normCandidate.toLowerCase().startsWith(normRootUpper.toLowerCase())) {
      const relative = normCandidate.slice(normRootUpper.length).replace(/^\\/, '')
      if (relative !== '') {
        setRevealTarget({ path: relative, line })
        onOpenFile(relative, line)
      }
    }
  }

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (saveTimer.current !== undefined) clearTimeout(saveTimer.current) }, [])

  /** 保存并返回是否成功（供「运行前保存」与 Ctrl+S 共用）。 */
  const saveNow = async (tab: EditorTab): Promise<boolean> => {
    const result = await apiWrite(root, tab.path, tab.content, tab.savedMtime)
    if (result.ok) {
      onDirtySave({ ...tab, savedMtime: result.value.mtime })
      setStatus(`已保存 ${tab.path}`)
    } else {
      setStatus(`保存失败: ${result.error.message}`)
    }
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setStatus(''), 2500)
    return result.ok
  }

  const save = (tab: EditorTab): void => {
    void saveNow(tab)
  }

  /** 运行当前文件：先保存（若 dirty），再交给 host 执行并展示输出面板。 */
  const runActive = async (): Promise<void> => {
    if (activeTab === null || output?.state === 'running') return
    if (activeTab.dirty && !(await saveNow(activeTab))) {
      setOutput({ state: 'done', error: '保存失败，已取消运行', result: EMPTY_RUN })
      return
    }
    setOutput({ state: 'running' })
    const result = await apiRun(root, activeTab.path)
    setOutput(result.ok
      ? { state: 'done', result: result.value }
      : { state: 'done', error: result.error.message, result: EMPTY_RUN })
  }

  const requestSave = (tab: EditorTab): void => {
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    save(tab)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab strip */}
      <div style={{
        display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--ide-border, #e5e6eb)',
        background: 'var(--ide-tabbar, rgba(127,127,127,0.06))', flexShrink: 0, overflowX: 'auto',
      }}>
        {tabs.length === 0 && (
          <div style={{ padding: '6px 12px', fontSize: 12, color: '#9ca3af' }}>
            从左侧文件树点击文件打开编辑器
          </div>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onActivate(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
              fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
              borderRight: '1px solid var(--ide-border, #e5e6eb)',
              background: tab.id === activeTabId ? 'var(--ide-tab-active, #ffffff)' : 'transparent',
              color: tab.id === activeTabId ? 'inherit' : '#6b7280',
            }}
            title={tab.path}
          >
            <span>{tab.dirty ? '● ' : ''}{tabTitle(tab.path)}</span>
            <span
              onClick={(event) => { event.stopPropagation(); onClose(tab.id) }}
              style={{ color: '#9ca3af', fontSize: 12, padding: '0 2px' }}
            >
              ✕
            </span>
          </div>
        ))}
        {/* 右侧按钮组：保存 | 终端 | 运行 | 关闭编辑区 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingRight: 8, flexShrink: 0 }}>
          <button
            onClick={() => { if (activeTab !== null) requestSave(activeTab) }}
            disabled={activeTab === null || !activeTab.dirty}
            title={activeTab === null ? '先打开一个文件' : activeTab.dirty ? `保存 ${activeTab.path}（Ctrl+S）` : '没有未保存的更改'}
            style={{
              padding: '4px 10px', fontSize: 12,
              cursor: activeTab !== null && activeTab.dirty ? 'pointer' : 'default',
              color: activeTab !== null && activeTab.dirty ? '#16a34a' : '#9ca3af',
              background: 'transparent', border: '1px solid var(--ide-border,#e5e6eb)',
              borderRadius: 4, whiteSpace: 'nowrap',
            }}
          >
            💾 保存
          </button>
          <button
            onClick={() => setTermVisible((visible) => !visible)}
            title="终端（显示/隐藏底部终端面板）"
            style={{
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              color: termVisible ? 'var(--ide-hl-keyword, #0000FF)' : '#9ca3af',
              background: 'transparent', border: '1px solid var(--ide-border,#e5e6eb)',
              borderRadius: 4, whiteSpace: 'nowrap',
            }}
          >
            {termVisible ? '▣ 终端' : '▢ 终端'}
          </button>
          <button
            onClick={() => { void runActive() }}
            disabled={activeTab === null || output?.state === 'running'}
            title={activeTab === null ? '先打开一个文件' : `运行 ${activeTab.path}`}
            style={{
              padding: '4px 10px', fontSize: 12, cursor: activeTab === null ? 'default' : 'pointer',
              color: activeTab === null ? '#9ca3af' : 'var(--ide-hl-keyword, #0000FF)',
              background: 'transparent', border: '1px solid var(--ide-border,#e5e6eb)',
              borderRadius: 4, whiteSpace: 'nowrap',
            }}
          >
            {output?.state === 'running' ? '⏳ 运行中…' : '▶ 运行'}
          </button>
          <button
            onClick={onCloseEditor}
            title="关闭编辑区"
            style={{
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              color: '#9ca3af', background: 'transparent', border: '1px solid var(--ide-border,#e5e6eb)',
              borderRadius: 4, whiteSpace: 'nowrap',
            }}
          >
            ✕ 关闭编辑区
          </button>
        </div>
      </div>

      {/* Editor body + terminal panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {activeTab === null ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 14 }}>
            选择左侧文件开始编辑
          </div>
        ) : (
          <CodeMirrorPane
            key={activeTab.id}
            tab={activeTab}
            onContentChange={onContentChange}
            onSave={(tab) => requestSave(tab)}
            lsp={lspFor(activeTab.path)}
            diagnostics={diagMap.get(normalizeUri(pathToUri(root, activeTab.path))) ?? []}
            onOpenLocation={onOpenLocation}
            revealLine={revealTarget !== null && revealTarget.path === activeTab.path ? revealTarget.line : null}
            onRevealDone={() => setRevealTarget(null)}
            root={root}
            onCursor={(line, column) => setCursorPos({ line, column })}
            onContextAction={(kind, text) => {
              if (kind === 'copy') {
                void writeClipboard(text)
              } else {
                onAskAgent(text, activeTab.path)
                setStatus('已发送到聊天区，按 Enter 发送')
                if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
                saveTimer.current = setTimeout(() => setStatus(''), 2500)
              }
            }}
          />
        )}
        {termVisible && (
          <div style={{
            height: termHeight,
            flexShrink: 0,
            position: 'relative',
            borderTop: '1px solid var(--ide-border,#e5e6eb)',
            background: 'var(--dsw-alias-bg-base,#ffffff)',
          }}>
            {/* 拖拽手柄：上拉=终端变高，下拉=变矮（clamp 120px ~ 视口 70%）；
                拖拽中直改 DOM（无 React 重渲染 → 不抖），松手同步状态并触发立即 fit */}
            <div
              onPointerDown={(event) => beginDragResize(event, 120, window.innerHeight * 0.7, (px) => setTermHeight(px), () => setTermFitTick((t) => t + 1))}
              title="拖拽调整终端高度"
              style={resizeHandleStyle()}
              onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'rgba(127,127,127,0.35)' }}
              onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' }}
            />
            <TerminalPane root={root} fitTick={termFitTick} />
          </div>
        )}
      </div>

      {/* 运行输出面板（编辑器下方，可拖拽调整高度，可关闭） */}
      {output !== null && (
        <div style={{
          height: outputHeight,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'relative',
          borderTop: '1px solid var(--ide-border,#e5e6eb)',
          background: 'var(--dsw-alias-bg-base,#ffffff)',
        }}>
          {/* 拖拽手柄：上拉=输出面板变高（clamp 100px ~ 视口 60%），拖拽中直改 DOM */}
          <div
            onPointerDown={(event) => beginDragResize(event, 100, window.innerHeight * 0.6, (px) => setOutputHeight(px))}
            title="拖拽调整输出面板高度"
            style={resizeHandleStyle()}
            onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'rgba(127,127,127,0.35)' }}
            onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px',
            fontSize: 12, color: '#6b7280', borderBottom: '1px dashed var(--ide-border,#e5e6eb)', flexShrink: 0,
          }}>
            <span>输出{output.state === 'running' ? ' · 运行中…' : ''}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {output.state === 'done' && output.result.stdoutTruncated && <span style={{ color: '#b45309' }}>stdout 已截断</span>}
              {output.state === 'done' && output.result.stderrTruncated && <span style={{ color: '#b45309' }}>stderr 已截断</span>}
              <button
                onClick={() => setOutput(null)}
                title="关闭输出"
                style={{ padding: '1px 8px', fontSize: 12, cursor: 'pointer', color: '#9ca3af', background: 'transparent', border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 4, fontFamily: 'inherit' }}
              >
                ✕
              </button>
            </span>
          </div>
          <pre style={{
            flex: 1, overflow: 'auto', margin: 0, padding: 8,
            fontSize: 12, lineHeight: 1.5,
            fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'inherit',
          }}>
            {output.state === 'done' && output.error !== undefined && <span style={{ color: '#dc2626' }}>{output.error}</span>}
            {output.state === 'done' && output.result.stdout}
            {output.state === 'done' && output.result.stderr !== '' && <span style={{ color: '#dc2626' }}>{output.result.stderr}</span>}
            {output.state === 'running' && <span style={{ color: '#9ca3af' }}>执行中，请稍候…</span>}
            {output.state === 'done' && `\n\n[进程退出码 ${output.result.exitCode ?? '?'}${output.result.timedOut ? '（超时已终止）' : ''} · 耗时 ${output.result.durationMs}ms]`}
          </pre>
        </div>
      )}

      {/* Status bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', padding: '3px 10px',
        fontSize: 12, color: '#6b7280', borderTop: '1px solid var(--ide-border, #e5e6eb)', flexShrink: 0,
        gap: 12, alignItems: 'center',
      }}>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center', overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{root}</span>
          {activeTab !== null && languageIdForPath(activeTab.path) !== null && (
            <span title="语言服务器状态">
              {lspStatus === '已连接' ? '✓ LSP' : lspStatus !== '' ? `… ${lspStatus}` : '… LSP'}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
          {activeTab !== null && (
            <>
              <span title="光标位置">{cursorPos !== null ? `行 ${cursorPos.line}, 列 ${cursorPos.column}` : ''}</span>
              <span title="语言">{languageIdForPath(activeTab.path) ?? 'plaintext'}</span>
              {(() => {
                const list = diagMap.get(normalizeUri(pathToUri(root, activeTab.path))) ?? []
                const errors = list.filter((d) => d.severity === 1).length
                const warnings = list.filter((d) => d.severity === 2).length
                if (errors === 0 && warnings === 0) return <span title="无诊断">✓</span>
                return (
                  <span title={`${errors} 错误, ${warnings} 警告`}>
                    {errors > 0 && <span style={{ color: '#dc2626' }}>{errors} 错误</span>}
                    {warnings > 0 && <span style={{ color: '#d97706' }}>{warnings} 警告</span>}
                  </span>
                )
              })()}
            </>
          )}
          <span>{status !== '' ? status : (activeTab !== null ? (activeTab.dirty ? '未保存' : '已保存') : '')}</span>
        </span>
      </div>
    </div>
  )
}

/** Open a file into the editor store (async load). */
export async function openFileInTabs(
  root: string,
  path: string,
  tabs: EditorTab[],
  activeTabId: string | null,
  onUpdate: (tabs: EditorTab[], active: string | null) => void,
): Promise<void> {
  const existing = tabs.find((tab) => tab.path === path)
  if (existing !== undefined) {
    onUpdate(tabs, existing.id)
    return
  }
  const result = await apiRead(root, path)
  if (!result.ok) return
  const tab: EditorTab = {
    id: `file:${path}`,
    path,
    title: tabTitle(path),
    content: result.value.content,
    dirty: false,
    savedMtime: result.value.mtime,
  }
  onUpdate([...tabs, tab], tab.id)
}
