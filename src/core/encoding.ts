/**
 * 文本编码白名单（client 编码选择菜单与 host 编解码校验共用）。
 * 只支持 iconv-lite / WHATWG 可覆盖的常见编码：中文 Windows 旧文件
 * （记事本 ANSI = GBK）与 UTF-8 是主要场景。
 */

/** 可写编码（读/写均支持）。'auto' 只用于读取时的自动检测，不入此表。 */
export const TEXT_ENCODING_IDS = ['utf-8', 'gbk', 'gb18030', 'big5', 'utf-16le', 'latin1'] as const

export type TextEncodingId = (typeof TEXT_ENCODING_IDS)[number]

export function isTextEncodingId(value: string): value is TextEncodingId {
  return (TEXT_ENCODING_IDS as readonly string[]).includes(value)
}

/** 编码 id → 展示名（状态栏显示）。 */
export const TEXT_ENCODING_LABELS: Readonly<Record<TextEncodingId, string>> = {
  'utf-8': 'UTF-8',
  gbk: 'GBK',
  gb18030: 'GB18030',
  big5: 'Big5',
  'utf-16le': 'UTF-16 LE',
  latin1: 'ISO-8859-1',
}

export function encodingLabel(id: string): string {
  return TEXT_ENCODING_LABELS[id as TextEncodingId] ?? id
}

/** 编码选择菜单项（'auto' = 读取时自动检测，仅读取选项）。 */
export const TEXT_ENCODING_CHOICES: ReadonlyArray<{ id: TextEncodingId | 'auto'; label: string }> = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'auto', label: '自动检测（乱码时推荐）' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'gbk', label: 'GBK' },
  { id: 'big5', label: 'Big5' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'latin1', label: 'ISO-8859-1' },
]
