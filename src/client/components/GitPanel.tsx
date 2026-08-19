/** Source-control panel: git status (staged/unstaged/untracked), stage /
 *  unstage / discard per file, inline diff, commit box, and recent history.
 *  Everything talks to the host git service (/dsh-ide/git/*, no shell). */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  apiGitCommit,
  apiGitCommitDiff,
  apiGitDiff,
  apiGitDiscard,
  apiGitLog,
  apiGitRepos,
  apiGitStage,
  apiGitStatus,
  apiGitUnstage,
  type GitLogEntry,
  type GitRepoInfo,
  type GitStatusEntry,
  type GitStatusResult,
} from '../api.ts'

interface GitPanelProps {
  root: string
}

const buttonStyle = (disabled = false): React.CSSProperties => ({
  padding: '2px 8px',
  fontSize: 11,
  cursor: disabled ? 'default' : 'pointer',
  color: '#6b7280',
  background: 'transparent',
  border: '1px solid var(--ide-border,#e5e6eb)',
  borderRadius: 3,
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
})

/** XY 状态 → 中文标签 + 颜色。 */
function describe(entry: GitStatusEntry): { label: string; color: string } {
  const xy = entry.xy
  if (xy === '??') return { label: '未跟踪', color: '#9ca3af' }
  const staged = xy[0] !== ' ' && xy[0] !== '?'
  const unstaged = xy[1] !== ' ' && xy[1] !== '?'
  if (staged && unstaged) return { label: '已暂存+修改', color: '#d97706' }
  if (staged) return { label: '已暂存', color: '#16a34a' }
  return { label: '已修改', color: '#d97706' }
}

/** 简易 diff 配色：+ 绿 / - 红 / 头蓝。 */
function DiffText({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  return (
    <pre style={{
      margin: 0, padding: 6, fontSize: 11, lineHeight: 1.5, overflow: 'auto',
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'inherit',
      background: 'rgba(127,127,127,0.05)', borderRadius: 4,
    }}>
      {lines.map((line, index) => {
        let color: string | undefined
        if (line.startsWith('+') && !line.startsWith('+++')) color = '#16a34a'
        else if (line.startsWith('-') && !line.startsWith('---')) color = '#dc2626'
        else if (line.startsWith('@@')) color = '#2563eb'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) color = '#6b7280'
        return <div key={index} style={{ color }}>{line === '' ? '\u00a0' : line}</div>
      })}
    </pre>
  )
}

export function GitPanel({ root }: GitPanelProps): JSX.Element {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string } | null>(null)
  const [log, setLog] = useState<GitLogEntry[] | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [commitDiff, setCommitDiff] = useState<{ hash: string; text: string } | null>(null)
  const [notice, setNotice] = useState('')
  /** Nested repos under the workspace root; empty when root itself is a repo. */
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  /** Currently targeted repo root ('' = workspace root). */
  const [activeRepo, setActiveRepo] = useState('')

  // The repo path every git call runs against: the selected nested repo, or
  // the workspace root when none was picked.
  const gitRoot = activeRepo !== '' ? activeRepo : root

  // Keep the freshest target in a ref so refresh() can switch repos without
  // recreating the callback (avoids a render loop via the root effect below).
  const activeRepoRef = useRef('')
  /** P2-03：repo 代际标记——切换 repo/root 后旧请求响应丢弃，防串面板。 */
  const repoGen = useRef(0)
  const pickRepo = (path: string): void => {
    activeRepoRef.current = path
    repoGen.current += 1
    setActiveRepo(path)
  }

  const flash = (text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice(''), 2500)
  }

  const refresh = useCallback((): void => {
    const target = activeRepoRef.current !== '' ? activeRepoRef.current : root
    if (target === '') return
    const gen = repoGen.current
    void apiGitStatus(target).then((result) => {
      if (gen !== repoGen.current) return
      if (result.ok) {
        setStatus(result.value)
        setError(null)
        // Workspace root is not a repo: discover nested repos once and auto-pick
        // the first one so the panel still shows git state for sub-projects.
        if (!result.value.isRepo && activeRepoRef.current === '') {
          void apiGitRepos(root).then((reposResult) => {
            if (gen !== repoGen.current) return
            if (reposResult.ok && reposResult.value.length > 0) {
              setRepos(reposResult.value)
              pickRepo(reposResult.value[0]!.path)
            } else {
              setRepos([])
            }
          })
        }
      } else {
        setError(result.error.message)
      }
    })
  }, [root])

  useEffect(() => {
    setStatus(null)
    setDiff(null)
    setLog(null)
    setShowLog(false)
    setCommitDiff(null)
    setRepos([])
    activeRepoRef.current = ''
    repoGen.current += 1
    setActiveRepo('')
    refresh()
  }, [root, refresh])

  // When the target repo changes (auto-pick or manual selection), reload status.
  useEffect(() => {
    if (activeRepo !== '' && activeRepo !== root) refresh()
  }, [activeRepo, root, refresh])

  /** 跑一个 git 操作，完成后刷新状态。 */
  const run = async (label: string, fn: () => Promise<boolean>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const ok = await fn()
      if (ok) {
        flash(label)
        setDiff(null)
        refresh()
      } else {
        setError('git 操作失败')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setBusy(false)
  }

  const viewDiff = (path: string, staged: boolean): void => {
    const gen = repoGen.current
    void apiGitDiff(gitRoot, path, staged).then((result) => {
      if (gen !== repoGen.current) return
      if (result.ok) setDiff({ path, staged, text: result.value })
      else setError(result.error.message)
    })
  }

  const commit = (): void => {
    const text = message.trim()
    if (text === '') return
    setMessage('')
    void run('已提交', () => apiGitCommit(gitRoot, text).then((r) => r.ok))
  }

  const loadLog = (): void => {
    const next = !showLog
    setShowLog(next)
    if (next && log === null) {
      const gen = repoGen.current
      void apiGitLog(gitRoot, 20).then((result) => {
        if (gen !== repoGen.current) return
        if (result.ok) setLog(result.value)
        else setError(result.error.message)
      })
    }
  }

  if (root === '') {
    return <div style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>请先打开一个工作区会话</div>
  }
  const stagedCount = status === null ? 0 : status.entries.filter((entry) => entry.xy[0] !== ' ' && entry.xy[0] !== '?').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* 标题行：分支 + 仓库选择 + 操作 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
        borderBottom: '1px solid var(--ide-border,#e5e6eb)', flexShrink: 0,
      }}>
        <span style={{
          flex: '1 1 auto', minWidth: 0, fontSize: 12, fontWeight: 600,
          color: 'var(--ide-muted,#6b7280)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {status === null ? 'Git' : status.isRepo ? `分支 ${status.branch ?? 'HEAD'}` : '非 Git 仓库'}
        </span>
        {repos.length > 0 && (
          <select
            value={gitRoot}
            onChange={(event) => { activeRepoRef.current = event.target.value; setActiveRepo(event.target.value) }}
            style={{
              fontSize: 11, flex: '0 0 auto', maxWidth: 280,
              background: 'var(--dsw-alias-bg-base,#ffffff)',
              color: 'inherit', border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 3, padding: '1px 4px',
            }}
            title={repos.find((repo) => repo.path === gitRoot)?.name ?? '选择 Git 仓库'}
          >
            {repos.map((repo) => (
              <option key={repo.path} value={repo.path}>{repo.name}（{repo.branch}）</option>
            ))}
          </select>
        )}
        <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 6 }}>
          <button type="button" onClick={loadLog} style={buttonStyle(busy)}>{showLog ? '状态' : '历史'}</button>
          <button type="button" onClick={() => refresh()} style={buttonStyle(busy)} disabled={busy}>⟳</button>
        </span>
      </div>
      {notice !== '' && (
        <div style={{ padding: '2px 10px', fontSize: 11, color: '#16a34a', flexShrink: 0 }}>{notice}</div>
      )}
      {error !== null && (
        <div style={{ padding: '4px 10px', fontSize: 11, color: '#dc2626', wordBreak: 'break-all', flexShrink: 0 }}>⚠ {error}</div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {status !== null && !status.isRepo && (
          <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>当前工作区不是 Git 仓库。</div>
        )}
        {showLog ? (
          log === null
            ? <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>加载历史…</div>
            : log.length === 0
              ? <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>暂无提交记录</div>
              : log.map((entry) => (
                <div key={entry.hash}>
                  <div
                    style={{ padding: '4px 10px', fontSize: 12, borderBottom: '1px dashed var(--ide-border,#e5e6eb)', cursor: 'pointer' }}
                    onClick={() => {
                      if (commitDiff !== null && commitDiff.hash === entry.hash) {
                        setCommitDiff(null)
                        return
                      }
                      setCommitDiff({ hash: entry.hash, text: '加载中…' })
                      const gen = repoGen.current
                      void apiGitCommitDiff(gitRoot, entry.hash).then((result) => {
                        if (gen !== repoGen.current) return
                        setCommitDiff(result.ok
                          ? { hash: entry.hash, text: result.value }
                          : { hash: entry.hash, text: `加载失败: ${result.error.message}` })
                      })
                    }}
                    onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'var(--ide-hover, rgba(127,127,127,0.1))' }}
                    onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' }}
                    title="点击查看该提交的 diff"
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: '#d97706', fontFamily: 'ui-monospace, Consolas, monospace' }}>{entry.hash}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{entry.subject}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      {entry.author} · {entry.date.slice(0, 10)} {entry.refs !== '' ? ` · ${entry.refs}` : ''}
                    </div>
                  </div>
                  {commitDiff !== null && commitDiff.hash === entry.hash && (
                    <div style={{ padding: '2px 10px 8px', cursor: 'default' }}>
                      <DiffText text={commitDiff.text} />
                    </div>
                  )}
                </div>
              ))
        ) : (
          <>
            {status !== null && status.entries.length === 0 && status.isRepo && (
              <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>工作区干净 ✓</div>
            )}
            {status?.entries.map((entry) => {
              const { label, color } = describe(entry)
              const isStaged = entry.xy[0] !== ' ' && entry.xy[0] !== '?'
              const isDiffOpen = diff !== null && diff.path === entry.path && diff.staged === isStaged
              return (
                <div key={entry.path}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
                      fontSize: 12, cursor: 'pointer', lineHeight: '20px',
                    }}
                    onMouseEnter={(event) => { (event.currentTarget as HTMLElement).style.background = 'var(--ide-hover, rgba(127,127,127,0.1))' }}
                    onMouseLeave={(event) => { (event.currentTarget as HTMLElement).style.background = 'transparent' }}
                    onClick={() => viewDiff(entry.path, isStaged)}
                    title={entry.path}
                  >
                    <span style={{ color, width: 26, flexShrink: 0, fontFamily: 'ui-monospace, Consolas, monospace' }}>{entry.xy}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{entry.path}</span>
                    <span style={{ color, fontSize: 11, flexShrink: 0 }}>{label}</span>
                    <span style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={(event) => event.stopPropagation()}>
                      {isStaged
                        ? <button type="button" disabled={busy} style={buttonStyle(busy)} onClick={() => void run('已取消暂存', () => apiGitUnstage(gitRoot, entry.path).then((r) => r.ok))}>取消暂存</button>
                        : <button type="button" disabled={busy} style={buttonStyle(busy)} onClick={() => void run('已暂存', () => apiGitStage(gitRoot, entry.path).then((r) => r.ok))}>{entry.xy === '??' ? '添加' : '暂存'}</button>}
                      {!isStaged && entry.xy !== '??' && (
                        <button type="button" disabled={busy} style={buttonStyle(busy)} onClick={() => { if (window.confirm(`放弃对 ${entry.path} 的修改？`)) void run('已放弃修改', () => apiGitDiscard(gitRoot, entry.path).then((r) => r.ok)) }}>放弃</button>
                      )}
                    </span>
                  </div>
                  {isDiffOpen && (
                    <div style={{ padding: '2px 10px 6px', cursor: 'default' }} onClick={(event) => event.stopPropagation()}>
                      <DiffText text={diff.text === '' ? '（无差异）' : diff.text} />
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* 提交区（仅状态视图显示） */}
      {!showLog && status?.isRepo === true && (
        <div style={{ padding: 8, borderTop: '1px solid var(--ide-border,#e5e6eb)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            {stagedCount > 0 ? `${stagedCount} 个文件已暂存` : '没有已暂存的更改'}
          </div>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="提交信息（Ctrl+Enter 提交）"
            rows={2}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') commit()
            }}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'none',
              fontSize: 12, padding: '5px 8px', lineHeight: 1.5,
              background: 'var(--dsw-alias-bg-base,#ffffff)', color: 'inherit',
              border: '1px solid var(--ide-border,#e5e6eb)', borderRadius: 4,
              fontFamily: 'inherit', outline: 'none',
            }}
          />
          <button
            type="button"
            disabled={busy || message.trim() === '' || stagedCount === 0}
            onClick={commit}
            style={{
              ...buttonStyle(busy || message.trim() === '' || stagedCount === 0),
              color: busy || message.trim() === '' || stagedCount === 0 ? '#9ca3af' : '#16a34a',
              alignSelf: 'flex-end', padding: '4px 16px',
            }}
          >
            提交
          </button>
        </div>
      )}
    </div>
  )
}
