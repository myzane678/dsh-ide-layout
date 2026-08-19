/**
 * GitLens 式行内 blame：`git blame --porcelain` 输出解析（host 侧纯逻辑）。
 * 覆盖：多 commit 块、未提交行（全 0 hash）、同一 commit 不连续行、空输出。
 */
import { describe, expect, it } from 'vitest'
import { parseBlamePorcelain } from '../src/host/git.ts'

describe('parseBlamePorcelain', () => {
  it('解析单 commit 块：行号连续递增，header 字段正确', () => {
    const output = [
      'd4b3f2a1e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1 1 1 3',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0800',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0800',
      'summary fix bug in parser',
      'filename src/foo.ts',
      '\tline one',
      '\tline two',
      '\tline three',
    ].join('\n')
    expect(parseBlamePorcelain(output)).toEqual([
      { line: 1, hash: 'd4b3f2a1e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1', author: 'Alice', mail: 'alice@example.com', time: 1700000000, summary: 'fix bug in parser' },
      { line: 2, hash: 'd4b3f2a1e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1', author: 'Alice', mail: 'alice@example.com', time: 1700000000, summary: 'fix bug in parser' },
      { line: 3, hash: 'd4b3f2a1e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1', author: 'Alice', mail: 'alice@example.com', time: 1700000000, summary: 'fix bug in parser' },
    ])
  })

  it('未提交行：全 0 hash、author-time 为 0', () => {
    const output = [
      '0000000000000000000000000000000000000000 4 4 1',
      'author Not Committed Yet',
      'author-mail <>',
      'author-time 0',
      'author-tz +0000',
      'committer Not Committed Yet',
      'committer-mail <>',
      'committer-time 0',
      'committer-tz +0000',
      'summary ',
      'filename src/foo.ts',
      '\tline four',
    ].join('\n')
    expect(parseBlamePorcelain(output)).toEqual([
      { line: 4, hash: '0000000000000000000000000000000000000000', author: 'Not Committed Yet', mail: '', time: 0, summary: '' },
    ])
  })

  it('同一 commit 的不连续行输出多个块：行号按 final-lineno 正确落位', () => {
    const output = [
      'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1 10 1 1',
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1690000000',
      'author-tz +0000',
      'summary first hunk',
      'filename src/a.ts',
      '\tline one',
      'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2 20 2 1',
      'author Carol',
      'author-mail <carol@example.com>',
      'author-time 1691000000',
      'author-tz +0000',
      'summary second hunk',
      'filename src/a.ts',
      '\tline two',
      'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1 30 5 1',
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1690000000',
      'author-tz +0000',
      'summary first hunk again',
      'filename src/a.ts',
      '\tline five',
    ].join('\n')
    const parsed = parseBlamePorcelain(output)
    expect(parsed.map((item) => item.line)).toEqual([1, 2, 5])
    expect(parsed[0]!.hash).toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')
    expect(parsed[1]!.hash).toBe('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2')
    expect(parsed[2]!.hash).toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1')
  })

  it('空输出 / 非 blame 文本：返回空数组', () => {
    expect(parseBlamePorcelain('')).toEqual([])
    expect(parseBlamePorcelain('fatal: no such path in HEAD\n')).toEqual([])
  })

  it('header 字段缺失时容错：author/summary 为空串、time 为 0', () => {
    const output = [
      'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 1 7 1',
      'filename src/b.ts',
      '\tline seven',
    ].join('\n')
    expect(parseBlamePorcelain(output)).toEqual([
      { line: 7, hash: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1', author: '', mail: '', time: 0, summary: '' },
    ])
  })
})
