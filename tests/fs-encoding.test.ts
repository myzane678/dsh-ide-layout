/**
 * FsService 编码读写与二进制图片读取集成测试（真实临时目录 + mock gate）。
 * 验证：GBK 按指定编码读取、auto 检测、按原编码写回字节一致、非法编码拒绝、
 * readBinary 的 base64/mime 与扩展名白名单。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsService } from '../src/host/fs-service.ts'
import { decodeText, encodeText } from '../src/host/encoding.ts'

let dir: string
const gate = async (root: string): Promise<{ ok: true; canonical: string }> => ({ ok: true, canonical: root })

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-ide-fs-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FsService 编码读写', () => {
  it('GBK 文件按 gbk 解码，auto 检测返回 gb18030', async () => {
    const svc = new FsService(gate)
    const rel = 'gbk.txt'
    await writeFile(join(dir, rel), encodeText('中文内容，编码测试', 'gbk'))
    const read = await svc.read(dir, rel, 'gbk')
    expect('content' in read).toBe(true)
    if ('content' in read) {
      expect(read.content).toBe('中文内容，编码测试')
      expect(read.encoding).toBe('gbk')
    }
    const auto = await svc.read(dir, rel, 'auto')
    expect('content' in auto).toBe(true)
    if ('content' in auto) {
      expect(auto.encoding).toBe('gb18030')
      expect(auto.content).toBe('中文内容，编码测试')
    }
  })

  it('UTF-8 文件默认读取编码为 utf-8', async () => {
    const svc = new FsService(gate)
    const rel = 'utf8.txt'
    await writeFile(join(dir, rel), '你好 hello', 'utf8')
    const read = await svc.read(dir, rel)
    expect('content' in read).toBe(true)
    if ('content' in read) {
      expect(read.content).toBe('你好 hello')
      expect(read.encoding).toBe('utf-8')
    }
  })

  it('按读取时的编码写回，磁盘字节保持 GBK', async () => {
    const svc = new FsService(gate)
    const rel = 'gbk-write.txt'
    await writeFile(join(dir, rel), encodeText('写入测试', 'gbk'))
    const read = await svc.read(dir, rel, 'auto')
    expect('content' in read).toBe(true)
    if (!('content' in read)) return
    const written = await svc.write(dir, rel, `${read.content}，追加`, read.mtime, read.encoding)
    expect('mtime' in written).toBe(true)
    const bytes = await readFile(join(dir, rel))
    const { text } = decodeText(bytes, 'gbk')
    expect(text).toBe('写入测试，追加')
    // 按 UTF-8 读回应出现乱码（证明字节确实是 GBK 而非 UTF-8）。
    expect(bytes.toString('utf8')).not.toBe('写入测试，追加')
  })

  it('非法编码读取返回 encoding-unsupported', async () => {
    const svc = new FsService(gate)
    await writeFile(join(dir, 'x.txt'), 'x', 'utf8')
    const read = await svc.read(dir, 'x.txt', 'utf-7' as never)
    expect('content' in read).toBe(false)
    if (!('content' in read)) expect(read.code).toBe('encoding-unsupported')
  })

  it('非法编码写入返回 encoding-unsupported', async () => {
    const svc = new FsService(gate)
    const written = await svc.write(dir, 'y.txt', 'x', undefined, 'binary' as never)
    expect('mtime' in written).toBe(false)
    if (!('mtime' in written)) expect(written.code).toBe('encoding-unsupported')
  })
})

describe('FsService readBinary 图片读取', () => {
  // 1×1 透明 PNG。
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  it('返回 base64 + mime + size', async () => {
    const svc = new FsService(gate)
    const rel = 'pic.png'
    await writeFile(join(dir, rel), PNG)
    const bin = await svc.readBinary(dir, rel)
    expect('data' in bin).toBe(true)
    if ('data' in bin) {
      expect(bin.mime).toBe('image/png')
      expect(bin.data).toBe(PNG.toString('base64'))
      expect(bin.size).toBe(PNG.length)
    }
  })

  it('jpeg 扩展名映射 image/jpeg（大小写不敏感）', async () => {
    const svc = new FsService(gate)
    const rel = 'photo.JPG'
    await writeFile(join(dir, rel), PNG)
    const bin = await svc.readBinary(dir, rel)
    expect('data' in bin).toBe(true)
    if ('data' in bin) expect(bin.mime).toBe('image/jpeg')
  })

  it('非图片扩展名返回 unsupported-media', async () => {
    const svc = new FsService(gate)
    await writeFile(join(dir, 'note.txt'), 'hello', 'utf8')
    const bin = await svc.readBinary(dir, 'note.txt')
    expect('data' in bin).toBe(false)
    if (!('data' in bin)) expect(bin.code).toBe('unsupported-media')
  })

  it('svg 按文本处理（readBinary 拒绝）', async () => {
    const svc = new FsService(gate)
    await writeFile(join(dir, 'icon.svg'), '<svg/>', 'utf8')
    const bin = await svc.readBinary(dir, 'icon.svg')
    expect('data' in bin).toBe(false)
  })
})
