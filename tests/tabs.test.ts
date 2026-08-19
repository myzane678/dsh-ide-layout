/**
 * P2-08：tab 关闭规则单测（P2-01 回归）——关闭首/中/尾/唯一 tab 后
 * activeTabId 必须有效或为 null，绝不能指向已移除的 tab。
 */
import { describe, expect, it } from 'vitest'

interface Tab { id: string; path: string; title: string; content: string; dirty: boolean }

/** mount.tsx onClose 的函数式 update 逻辑（与实现保持一致）。 */
function closeTab(tabs: Tab[], activeTabId: string | null, closingId: string): { tabs: Tab[]; activeTabId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === closingId)
  const nextTabs = tabs.filter((tab) => tab.id !== closingId)
  let nextActive = activeTabId
  if (activeTabId === closingId) {
    nextActive = nextTabs[index]?.id ?? nextTabs[index - 1]?.id ?? null
  }
  return { tabs: nextTabs, activeTabId: nextActive }
}

function tabsOf(names: string[]): Tab[] {
  return names.map((name) => ({ id: name, path: name, title: name, content: '', dirty: false }))
}

describe('关闭 tab 后 activeTabId 计算（P2-01 回归）', () => {
  it('关闭活动中间 tab（[A,B,C]，关 B）→ 选中右侧 C（旧逻辑会错误指向 B）', () => {
    const { tabs, activeTabId } = closeTab(tabsOf(['A', 'B', 'C']), 'B', 'B')
    expect(tabs.map((t) => t.id)).toEqual(['A', 'C'])
    expect(activeTabId).toBe('C')
    expect(tabs.some((t) => t.id === activeTabId)).toBe(true)
  })

  it('关闭活动首个 tab（[A,B,C]，关 A）→ 选中 B', () => {
    const { tabs, activeTabId } = closeTab(tabsOf(['A', 'B', 'C']), 'A', 'A')
    expect(tabs.map((t) => t.id)).toEqual(['B', 'C'])
    expect(activeTabId).toBe('B')
  })

  it('关闭活动末尾 tab（[A,B,C]，关 C）→ 选中左侧 B', () => {
    const { tabs, activeTabId } = closeTab(tabsOf(['A', 'B', 'C']), 'C', 'C')
    expect(tabs.map((t) => t.id)).toEqual(['A', 'B'])
    expect(activeTabId).toBe('B')
  })

  it('关闭唯一 tab → null', () => {
    const { tabs, activeTabId } = closeTab(tabsOf(['A']), 'A', 'A')
    expect(tabs).toEqual([])
    expect(activeTabId).toBeNull()
  })

  it('关闭非活动 tab → activeTabId 不变且仍有效', () => {
    const { tabs, activeTabId } = closeTab(tabsOf(['A', 'B', 'C']), 'A', 'B')
    expect(tabs.map((t) => t.id)).toEqual(['A', 'C'])
    expect(activeTabId).toBe('A')
  })

  it('任意关闭后 activeTabId 有效或为 null（不变量）', () => {
    for (const names of [['A'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) {
      for (const active of names) {
        for (const closing of names) {
          const { tabs, activeTabId } = closeTab(tabsOf(names), active, closing)
          expect(activeTabId === null || tabs.some((t) => t.id === activeTabId)).toBe(true)
        }
      }
    }
  })
})
