/**
 * Host 侧文本编解码：iconv-lite 负责多编码（GBK/GB18030/Big5/UTF-16LE 等），
 * 自动检测用于「打开乱码时选一次自动检测」的场景。
 * 约定：
 * - 解码后剥离开头的 U+FEFF（UTF-8 / UTF-16 BOM 残留），保存时不写 BOM
 *   （与 VS Code 默认「UTF-8 without BOM」一致）。
 * - utf-16le 在 iconv-lite 的标签是 'utf16-le'，此处统一转换。
 */

import iconv from 'iconv-lite'
import type { TextEncodingId } from '../core/encoding.ts'

/** iconv-lite 标签归一化（'utf-16le' → 'utf16-le'）。 */
function iconvLabel(encoding: TextEncodingId): string {
  return encoding === 'utf-16le' ? 'utf16-le' : encoding
}

/** 严格 UTF-8 校验（含过长编码 / 代理区 / 超范围检查）。 */
export function isValidUtf8(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i]!
    if (b < 0x80) continue
    let extra = 0
    if (b >= 0xc2 && b <= 0xdf) extra = 1
    else if (b >= 0xe0 && b <= 0xef) extra = 2
    else if (b >= 0xf0 && b <= 0xf4) extra = 3
    else return false
    if (i + extra >= data.length) return false
    for (let j = 1; j <= extra; j += 1) {
      const c = data[i + j]!
      if (c < 0x80 || c > 0xbf) return false
    }
    // 过长编码（双字节应 ≥ U+0080，三字节 ≥ U+0800，四字节 ≥ U+10000）
    if (extra === 2 && b === 0xe0 && data[i + 1]! < 0xa0) return false
    // 代理区（U+D800–U+DFFF）
    if (extra === 2 && b === 0xed && data[i + 1]! >= 0xa0) return false
    // 超范围（> U+10FFFF）
    if (extra === 3 && b === 0xf0 && data[i + 1]! < 0x90) return false
    if (extra === 3 && b === 0xf4 && data[i + 1]! >= 0x90) return false
    i += extra
  }
  return true
}

/** 自动检测：严格 UTF-8 → GB18030（GBK 超集，覆盖中文 ANSI）→ UTF-8 保底。 */
export function detectTextEncoding(data: Uint8Array): TextEncodingId {
  if (isValidUtf8(data)) return 'utf-8'
  try {
    const decoded = iconv.decode(Buffer.from(data), 'gb18030')
    if (!decoded.includes('\uFFFD')) return 'gb18030'
  } catch {
    // 忽略：落到 UTF-8 保底
  }
  return 'utf-8'
}

/** 按编码解码；'auto' 先检测再解码，返回实际使用的编码。 */
export function decodeText(
  data: Uint8Array,
  encoding: TextEncodingId | 'auto',
): { text: string; encoding: TextEncodingId } {
  const used = encoding === 'auto' ? detectTextEncoding(data) : encoding
  let text = iconv.decode(Buffer.from(data), iconvLabel(used))
  // 剥离 BOM 残留（UTF-8 / UTF-16 开头 U+FEFF）。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, encoding: used }
}

/** 按编码编码（UTF-16LE 写 BOM：iconv 的 utf16-le 不自动加 BOM，需手动补）。 */
export function encodeText(text: string, encoding: TextEncodingId): Buffer {
  if (encoding === 'utf-16le') {
    const body = iconv.encode(text, 'utf16-le')
    const withBom = Buffer.alloc(body.length + 2)
    withBom.writeUInt16LE(0xfeff, 0)
    body.copy(withBom, 2)
    return withBom
  }
  return iconv.encode(text, iconvLabel(encoding))
}
