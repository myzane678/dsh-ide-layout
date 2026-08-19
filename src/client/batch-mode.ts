/**
 * 简易 batch/cmd 语法高亮：行首注释（rem / ::）、@ 指令、命令关键字、
 * %变量%（%VAR% / %1 / %~dp0）、双引号字符串、标签（:label）。
 * batch 语法不复杂，CodeMirror 官方也没有对应的语言包（legacy-modes 只有
 * shell / powershell），所以自写一个 CM5 风格的 StreamParser 覆盖主要元素。
 * token 返回的样式名（comment/keyword/string/number/def/meta）由
 * StreamLanguage 映射到 @lezer/highlight 标签，与 EditorPane 的 ideHighlight
 * 配色规则对应。
 */
import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'

/** 常见 batch 命令 / 控制关键字（大小写不敏感，查询前统一小写）。 */
const KEYWORDS = new Set([
  'echo', 'set', 'if', 'else', 'for', 'in', 'do', 'goto', 'call', 'exit',
  'pause', 'title', 'color', 'cd', 'chdir', 'dir', 'copy', 'xcopy', 'del',
  'erase', 'mkdir', 'md', 'rmdir', 'rd', 'move', 'ren', 'rename', 'start',
  'shift', 'choice', 'find', 'findstr', 'type', 'pushd', 'popd', 'cls',
  'date', 'time', 'ver', 'vol', 'where', 'whoami', 'tasklist', 'taskkill',
  'setlocal', 'endlocal', 'assoc', 'ftype', 'path', 'prompt', 'rem',
  'errorlevel', 'defined', 'not', 'exist', 'attrib', 'reg', 'ping',
  'ipconfig', 'tree', 'sort', 'more',
])

function tokenBase(stream: StringStream): string | null {
  const start = stream.pos
  // 行首：注释（:: 或 rem）与标签（:label）。用 ^\s* 容忍前导缩进。
  if (stream.sol()) {
    if (stream.match(/^\s*::/) || stream.match(/^\s*rem\b/i)) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^\s*:[^:\s]/)) {
      stream.skipToEnd()
      return 'def'
    }
  }
  if (stream.eatSpace()) return null
  // @echo off 这类 @ 前缀指令
  if (stream.peek() === '@') {
    stream.next()
    return 'meta'
  }
  const ch = stream.next()!
  if (ch === '"') {
    // 双引号字符串：直到闭合引号或行尾（batch 允许引号不闭合）
    while (!stream.eol()) {
      if (stream.next() === '"') break
    }
    return 'string'
  }
  if (ch === '%') {
    // %VAR% / %1 / %* / %~dp0 / %%i：吃到下一个 % 或行尾
    stream.eatWhile(/[^%]/)
    if (!stream.eol()) stream.next()
    return 'def'
  }
  if (ch === ':') {
    // 行中标签：goto :end
    stream.eatWhile(/[\w.\\/]/)
    return 'def'
  }
  if (/\d/.test(ch)) {
    stream.eatWhile(/[\d.]/)
    return 'number'
  }
  // 非命令字符（括号 / 比较符 / 管道等）单独成 token，无色且不吞后续命令字
  if (!/[\w.\\/]/.test(ch)) return null
  // 命令字（允许 . \ / 后缀，如 echo.、cd..、.\setup.bat）；末尾的 . / :
  // 是变体后缀（echo. / echo:），去掉后再查关键字表。用本地 start 记录
  // token 起点（不依赖 stream.start，该字段由 StreamLanguage 运行时在每次
  // token 前重置，独立调用时不可靠）
  stream.eatWhile(/[\w.\\/]/)
  const cur = stream.string.slice(start, stream.pos).toLowerCase().replace(/[.:]$/, '')
  // set FOO=bar：等号左侧是变量定义（cur 需为非空词，避免 == 误判）
  if (stream.peek() === '=' && /\w/.test(cur)) return 'def'
  return KEYWORDS.has(cur) ? 'keyword' : null
}

/** batch/cmd 高亮语言（自写 StreamParser，无第三方依赖）。 */
export const batchParser: StreamParser<object> = {
  name: 'batch',
  startState: () => ({}),
  token(stream, _state) {
    return tokenBase(stream)
  },
}

/** 可直接挂进 CodeMirror 的语言扩展。 */
export const batchLanguage = StreamLanguage.define(batchParser)
