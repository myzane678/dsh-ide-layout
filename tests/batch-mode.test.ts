/**
 * batch/cmd 高亮 tokenizer 单测：注释（rem/::）、@ 指令、关键字、
 * %变量%、字符串、标签（:label）的样式标签逐一验证。
 */
import { describe, expect, it } from 'vitest'
import { StringStream } from '@codemirror/language'
import { batchParser } from '../src/client/batch-mode.ts'

/** 把一行切成 [文本, 样式] 序列（样式 null = 无高亮）。
 *  StringStream.start 由 StreamLanguage 的 Parse 在每次 token 前重置，
 *  单测里手动维护 last 记录 token 起点。 */
function tokensOf(line: string): Array<[string, string | null]> {
  const stream = new StringStream(line)
  const state = batchParser.startState!(4)
  const out: Array<[string, string | null]> = []
  let last = 0
  while (!stream.eol()) {
    const style = batchParser.token(stream, state)
    if (stream.pos > last) {
      out.push([line.slice(last, stream.pos), style])
      last = stream.pos
    } else {
      stream.next() // 防御：token 未推进时强制前进，避免死循环
    }
  }
  return out
}

/** 只保留有样式的 token（断言时忽略空格 / 无色片段）。 */
function styled(line: string): Array<[string, string]> {
  return tokensOf(line).filter(
    (t): t is [string, string] => t[1] !== null,
  )
}

describe('batch/cmd 高亮 tokenizer', () => {
  it('@echo off：@ 为 meta，echo 为 keyword', () => {
    expect(styled('@echo off')).toEqual([['@', 'meta'], ['echo', 'keyword']])
  })

  it('rem 与 :: 行注释整行高亮为 comment', () => {
    expect(styled(':: 这是一个注释')).toEqual([[':: 这是一个注释', 'comment']])
    expect(styled('rem set FOO=1')).toEqual([['rem set FOO=1', 'comment']])
  })

  it('标签 :label 与 goto :label 高亮为 def', () => {
    expect(styled(':end')).toEqual([[':end', 'def']])
    expect(styled('goto :end')).toEqual([['goto', 'keyword'], [':end', 'def']])
  })

  it('set 命令：关键字 + 引号字符串 / 等号左侧变量定义', () => {
    expect(styled('set "FOO=bar"')).toEqual([['set', 'keyword'], ['"FOO=bar"', 'string']])
    expect(styled('set FOO=bar')).toEqual([['set', 'keyword'], ['FOO', 'def']])
  })

  it('%变量% 高亮为 def（含 %~dp0 带修饰，引号内不拆分）', () => {
    expect(styled('echo %PATH%')).toEqual([['echo', 'keyword'], ['%PATH%', 'def']])
    expect(styled('call "%~dp0setup.bat"')).toEqual([
      ['call', 'keyword'], ['"%~dp0setup.bat"', 'string'],
    ])
  })

  it('数字高亮为 number', () => {
    expect(styled('set /a N=42')).toEqual([['set', 'keyword'], ['N', 'def'], ['42', 'number']])
  })

  it('if 块：关键字/字符串有样式，比较符与括号无色', () => {
    expect(styled('if "%x%"=="y" (del "a b.txt")')).toEqual([
      ['if', 'keyword'], ['"%x%"', 'string'], ['"y"', 'string'],
      ['del', 'keyword'], ['"a b.txt"', 'string'],
    ])
  })
})
