/**
 * 图片文件识别（client 判断 tab 类型 / host 判断 mime 共用）。
 * svg 刻意排除：它是文本格式，默认按文本编辑（与 VS Code 默认一致），
 * 位图（png/jpg/gif/webp/bmp/ico/avif）按二进制读取并预览。
 */

/** 扩展名（小写）→ MIME。 */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** 二进制图片读取上限（防超大文件打爆内存）。 */
export const IMAGE_CAP_BYTES = 25 * 1024 * 1024

/** 路径是否为可预览的位图图片（svg 除外，按文本处理）。 */
export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== null
}

/** 路径的图片 MIME；非图片返回 null。 */
export function imageMimeForPath(path: string): string | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return IMAGE_MIME[ext] ?? null
}
