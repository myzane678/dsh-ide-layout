/** Java/现有语言识别回归：编辑器与 LSP 选择必须保持一致。 */
import { describe, expect, it } from 'vitest'
import { languageIdForPath } from '../src/core/types.ts'
import { lspServerForPath, uriWithinRoot, FrameReader } from '../src/host/lsp-service.ts'
import { completionTextRange, lspPositionToOffset, pathToUri, signatureParameterRange, type LspCompletionItem, type LspSignatureHelp } from '../src/client/lsp-client.ts'

describe('语言识别', () => {
  it('Java 源文件使用 java languageId 与 JDTLS server kind', () => {
    expect(languageIdForPath('src/main/java/App.java')).toBe('java')
    expect(lspServerForPath('src/main/java/App.java')).toBe('java')
  })

  it('Java 相关文件仍只对 .java 启用 JDTLS', () => {
    expect(languageIdForPath('pom.xml')).toBeNull()
    expect(languageIdForPath('build.gradle')).toBeNull()
    expect(lspServerForPath('README.md')).toBeNull()
  })

  it('原有语言路由不回退到 Java', () => {
    expect(languageIdForPath('src/main.ts')).toBe('typescript')
    expect(lspServerForPath('src/main.ts')).toBe('ts')
    expect(languageIdForPath('script.py')).toBe('python')
    expect(lspServerForPath('script.py')).toBe('py')
    expect(languageIdForPath('script.ps1')).toBe('powershell')
    expect(lspServerForPath('script.ps1')).toBe('ps')
  })
})

describe('LSP 编辑器适配', () => {
  it('按 LSP textEdit.range 计算导入补全的替换范围', () => {
    const item: LspCompletionItem = {
      label: 'RandomForestClassifier',
      textEdit: { range: { start: { line: 0, character: 28 }, end: { line: 0, character: 28 } }, newText: 'RandomForestClassifier' },
    }
    expect(completionTextRange(item, 'from sklearn.ensemble import ', { from: 28, to: 28 })).toEqual({ from: 28, to: 28 })
  })

  it('保留多行文本中的 LSP 位置偏移', () => {
    expect(lspPositionToOffset('第一行\nfrom sklearn import ', { line: 1, character: 20 })).toBe(24)
  })

  it('提取签名提示当前参数范围', () => {
    const help: LspSignatureHelp = {
      signatures: [{ label: 'fit(X, y, sample_weight=None)', parameters: [{ label: 'X' }, { label: 'y' }, { label: 'sample_weight=None' }] }],
      activeParameter: 1,
    }
    expect(signatureParameterRange(help)).toEqual({ label: 'fit(X, y, sample_weight=None)', activeFrom: 7, activeTo: 8 })
  })

  it('pathToUri 对空格/#/%/非 ASCII 路径做百分号编码，保留盘符冒号', () => {
    expect(pathToUri('E:/work dir', 'a b#c%.py')).toBe('file:///E:/work%20dir/a%20b%23c%25.py')
    expect(pathToUri('E:/work dir', '中文.py')).toContain('%E4%B8%AD%E6%96%87.py')
  })

  it('lspPositionToOffset 按 UTF-16 计算（emoji 占两个码元）', () => {
    expect(lspPositionToOffset('x😀y\nz', { line: 0, character: 4 })).toBe(4)
    expect(lspPositionToOffset('x😀y\nz', { line: 1, character: 1 })).toBe(6)
  })

  it('uriWithinRoot 要求目录段边界，防止 /project 匹配 /project2', () => {
    const prefix = 'file:///e:/work dir'
    expect(uriWithinRoot('file:///e:/work%20dir/a.py', prefix)).toBe(true)
    expect(uriWithinRoot('file:///e:/work dir/a.py', prefix)).toBe(true)
    expect(uriWithinRoot('file:///e:/work%20dir2/a.py', prefix)).toBe(false)
    expect(uriWithinRoot('file:///e:/other/a.py', prefix)).toBe(false)
  })

  it('uriWithinRoot 兼容编码后的根前缀（客户端 pathToUri 形式）', () => {
    const encodedPrefix = 'file:///e:/work%20dir'
    expect(uriWithinRoot('file:///e:/work%20dir/a.py', encodedPrefix)).toBe(true)
    expect(uriWithinRoot('file:///e:/work%20dir2/a.py', encodedPrefix)).toBe(false)
  })

  it('FrameReader 拒绝超过上限的 Content-Length 帧', () => {
    const reader = new FrameReader(64)
    const received: unknown[] = []
    const header = 'Content-Length: 200\r\n\r\n'
    const body = '{"jsonrpc":"2.0","id":1,"result":null}'
    expect(reader.push(Buffer.from(header + body), (m) => received.push(m))).toBe(false)
    expect(received).toEqual([])
  })

  it('FrameReader 正常拆分多帧消息', () => {
    const reader = new FrameReader(1024)
    const received: unknown[] = []
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' })
    const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
    expect(reader.push(Buffer.from(frame + frame), (m) => received.push(m))).toBe(true)
    expect(received).toHaveLength(2)
  })
})
