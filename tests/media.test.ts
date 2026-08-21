/**
 * 图片识别单测（core/media.ts）：扩展名白名单、大小写、svg 按文本处理。
 */
import { describe, expect, it } from 'vitest'
import { imageMimeForPath, isImagePath } from '../src/core/media.ts'

describe('isImagePath', () => {
  it('位图扩展名全部识别', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']) {
      expect(isImagePath(`assets/logo.${ext}`)).toBe(true)
    }
  })

  it('扩展名大小写不敏感', () => {
    expect(isImagePath('A.PNG')).toBe(true)
    expect(isImagePath('photo.JpEg')).toBe(true)
  })

  it('svg 按文本处理（不预览）', () => {
    expect(isImagePath('icon.svg')).toBe(false)
  })

  it('非图片文件不识别', () => {
    expect(isImagePath('main.ts')).toBe(false)
    expect(isImagePath('notes.md')).toBe(false)
    expect(isImagePath('archive.zip')).toBe(false)
  })

  it('无扩展名不识别', () => {
    expect(isImagePath('README')).toBe(false)
  })
})

describe('imageMimeForPath', () => {
  it('映射正确 MIME', () => {
    expect(imageMimeForPath('a.png')).toBe('image/png')
    expect(imageMimeForPath('a.jpg')).toBe('image/jpeg')
    expect(imageMimeForPath('a.jpeg')).toBe('image/jpeg')
    expect(imageMimeForPath('a.webp')).toBe('image/webp')
    expect(imageMimeForPath('a.ico')).toBe('image/x-icon')
  })

  it('非图片返回 null', () => {
    expect(imageMimeForPath('a.txt')).toBeNull()
    expect(imageMimeForPath('a.svg')).toBeNull()
  })
})
