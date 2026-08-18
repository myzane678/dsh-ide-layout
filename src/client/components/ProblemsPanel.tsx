/** 问题面板：聚合所有 LSP 诊断（按文件分组），点击条目打开文件并定位到行。
 *  数据源为 IdeState.diagnostics（EditorPane 上抛写入）。 */

import { type JSX } from 'react'
import { normalizeUri, pathToUri, type LspDiagnostic } from '../lsp-client.ts'

interface ProblemsPanelProps {
  root: string
  /** 归一化 uri → 诊断列表（来自 IdeState.diagnostics）。 */
  diagnostics: Record<string, LspDiagnostic[]>
  onOpenFile: (path: string, line?: number) => void
}

/** 严重度 → 标签与颜色。 */
function severityOf(diagnostic: LspDiagnostic): { label: string; color: string } {
  switch (diagnostic.severity) {
    case 1: return { label: '错误', color: '#dc2626' }
    case 2: return { label: '警告', color: '#d97706' }
    case 3: return { label: '信息', color: '#2563eb' }
    default: return { label: '提示', color: '#6b7280' }
  }
}

/** 归一化 uri → 相对 root 的路径（用于展示与打开）。 */
function uriToRelative(root: string, uri: string): string {
  const rootUri = normalizeUri(pathToUri(root, ''))
  if (root === '') return uri
  const decoded = normalizeUri(uri)
  const prefix = rootUri.replace(/\/$/, '')
  if (decoded.startsWith(prefix)) {
    return decoded.slice(prefix.length).replace(/^[\\/]/, '')
  }
  return decoded.replace(/^file:\/\//, '')
}

export function ProblemsPanel({ root, diagnostics, onOpenFile }: ProblemsPanelProps): JSX.Element {
  // 按文件分组（保持出现顺序），每组内部按行号排序。
  const files = new Map<string, Array<{ diagnostic: LspDiagnostic; line: number }>>()
  for (const [uri, list] of Object.entries(diagnostics)) {
    if (list.length === 0) continue
    const path = uriToRelative(root, uri)
    const entries = (files.get(path) ?? [])
    for (const diagnostic of list) {
      entries.push({ diagnostic, line: diagnostic.range.start.line + 1 })
    }
    entries.sort((a, b) => a.line - b.line)
    files.set(path, entries)
  }
  const total = Array.from(files.values()).reduce((sum, entries) => sum + entries.length, 0)

  if (total === 0) {
    return (
      <div style={{
        padding: '16px 12px', fontSize: 12, color: '#9ca3af', textAlign: 'center',
      }}>
        没有问题 ✨
        <div style={{ marginTop: 4, fontSize: 11 }}>LSP 诊断会显示在这里（需打开文件后由语言服务器推送）</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', fontSize: 12, lineHeight: 1.5 }}>
      <div style={{
        padding: '4px 10px', fontSize: 11, color: '#9ca3af',
        borderBottom: '1px solid var(--ide-border,#e5e6eb)', position: 'sticky', top: 0,
        background: 'var(--dsw-alias-bg-overlay, rgba(248,250,255,0.96))',
      }}>
        问题 · {total} 项 · {files.size} 个文件
      </div>
      {Array.from(files.entries()).map(([path, entries]) => (
        <div key={path}>
          <div style={{
            padding: '4px 10px', fontSize: 11, color: '#6b7280',
            background: 'rgba(127,127,127,0.06)', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>📄</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
            <span style={{ marginLeft: 'auto' }}>{entries.length}</span>
          </div>
          {entries.map(({ diagnostic, line }, index) => {
            const sev = severityOf(diagnostic)
            return (
              <div
                key={`${line}-${index}`}
                onClick={() => onOpenFile(path, line - 1)}
                title={`${path}:${line} — ${diagnostic.message}`}
                style={{
                  display: 'flex', gap: 8, alignItems: 'baseline', cursor: 'pointer',
                  padding: '2px 10px',
                }}
                onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))' }}
                onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span style={{ color: sev.color, flexShrink: 0 }}>{sev.label}</span>
                <span style={{ color: '#9ca3af', flexShrink: 0, minWidth: 28 }}>{line}</span>
                <span style={{ wordBreak: 'break-word' }}>{diagnostic.message}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
