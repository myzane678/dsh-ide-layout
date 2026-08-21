/**
 * 编码编解码与自动检测单测（host/encoding.ts）。
 * 覆盖：多编码往返、UTF-8 严格校验、GBK 自动检测、BOM 剥离、UTF-16LE 写 BOM。
 */
import { describe, expect, it } from 'vitest'
import { decodeText, detectTextEncoding, encodeText, isValidUtf8 } from '../src/host/encoding.ts'
import { isTextEncodingId, TEXT_ENCODING_IDS } from '../src/core/encoding.ts'

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('isValidUtf8 严格校验', () => {
  it('纯 ASCII 合法', () => {
    expect(isValidUtf8(utf8Bytes('hello world'))).toBe(true)
  })

  it('多字节中文合法', () => {
    expect(isValidUtf8(utf8Bytes('测试中文'))).toBe(true)
  })

  it('GBK 双字节高位序列非法（B2 E2 CA D4 非 UTF-8）', () => {
    expect(isValidUtf8(new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]))).toBe(false)
  })

  it('截断的多字节序列非法', () => {
    expect(isValidUtf8(new Uint8Array([0xe6, 0xb5]))).toBe(false)
  })

  it('代理区（ED A0 80 = U+D800）非法', () => {
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false)
  })

  it('空数组合法', () => {
    expect(isValidUtf8(new Uint8Array(0))).toBe(true)
  })
})

describe('decodeText / encodeText 往返', () => {
  const sample = '你好，世界 hello 123！'

  it('utf-8 往返一致', () => {
    const { text, encoding } = decodeText(encodeText(sample, 'utf-8'), 'utf-8')
    expect(encoding).toBe('utf-8')
    expect(text).toBe(sample)
  })

  it('gbk 往返一致', () => {
    const buf = encodeText(sample, 'gbk')
    expect(buf).not.toEqual(utf8Bytes(sample))
    const { text, encoding } = decodeText(buf, 'gbk')
    expect(encoding).toBe('gbk')
    expect(text).toBe(sample)
  })

  it('gb18030 往返一致', () => {
    const buf = encodeText(sample, 'gb18030')
    const { text } = decodeText(buf, 'gb18030')
    expect(text).toBe(sample)
  })

  it('big5 往返一致', () => {
    // 简体「你好」不在 Big5 码表，用繁体样本。
    const big5Sample = '你好，世界！（繁體）'
    const buf = encodeText(big5Sample, 'big5')
    const { text } = decodeText(buf, 'big5')
    expect(text).toBe(big5Sample)
  })

  it('utf-16le 往返一致且写入带 BOM', () => {
    const buf = encodeText(sample, 'utf-16le')
    // BOM：FF FE
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xfe)
    const { text, encoding } = decodeText(buf, 'utf-16le')
    expect(encoding).toBe('utf-16le')
    expect(text).toBe(sample)
  })

  it('latin1 往返一致（仅低字节可表示）', () => {
    const latinSample = 'caf\xe9 \u00e0 propos' // é / à
    const buf = encodeText(latinSample, 'latin1')
    const { text } = decodeText(buf, 'latin1')
    expect(text).toBe(latinSample)
  })

  it('utf-8 BOM 解码后被剥离', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Bytes(sample))])
    const { text } = decodeText(withBom, 'utf-8')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(text).toBe(sample)
  })
})

describe('detectTextEncoding 自动检测', () => {
  it('UTF-8 中文 → utf-8', () => {
    expect(detectTextEncoding(utf8Bytes('中文内容'))).toBe('utf-8')
  })

  it('GBK 中文 → gb18030（覆盖 GBK 超集）', () => {
    const gbk = encodeText('中文内容，编码测试。', 'gbk')
    expect(detectTextEncoding(gbk)).toBe('gb18030')
  })

  it('纯 ASCII → utf-8', () => {
    expect(detectTextEncoding(utf8Bytes('plain ascii'))).toBe('utf-8')
  })

  it('非法 UTF-8 且 GBK 可解码 → gb18030（decodeText auto 路径）', () => {
    const gbk = encodeText('这是一个GBK文件', 'gbk')
    const { text, encoding } = decodeText(gbk, 'auto')
    expect(encoding).toBe('gb18030')
    expect(text).toBe('这是一个GBK文件')
  })
})

describe('编码白名单', () => {
  it('全部 id 均被 isTextEncodingId 接受', () => {
    for (const id of TEXT_ENCODING_IDS) expect(isTextEncodingId(id)).toBe(true)
  })

  it('非法编码被拒绝', () => {
    expect(isTextEncodingId('utf-7')).toBe(false)
    expect(isTextEncodingId('')).toBe(false)
    expect(isTextEncodingId('binary')).toBe(false)
  })
})
