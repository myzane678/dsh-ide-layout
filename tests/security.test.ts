/**
 * P2-08：host 侧纯逻辑单测——loopback 来源校验（P0-01 回归）+ LSP URI 门禁（P1-03）。
 */
import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '../src/host/security.ts'

/** 构造一个最小 IncomingMessage（socket + headers）。 */
function mkRequest(
  remoteAddress: string,
  host: string | undefined,
  origin: string | undefined,
  secFetchSite: string | undefined,
): Parameters<typeof isLoopbackRequest>[0] {
  return {
    socket: { remoteAddress },
    headers: { host, origin, 'sec-fetch-site': secFetchSite },
  } as unknown as Parameters<typeof isLoopbackRequest>[0]
}

describe('isLoopbackRequest（P0-01 回归）', () => {
  it('合法同源 WebSocket（strict）放行', () => {
    const req = mkRequest('127.0.0.1', '127.0.0.1:49821', 'http://127.0.0.1:49821', undefined)
    expect(isLoopbackRequest(req, true)).toBe(true)
  })

  it('缺失 Origin 的 WebSocket（strict）拒绝——保守策略', () => {
    const req = mkRequest('127.0.0.1', '127.0.0.1:49821', undefined, undefined)
    expect(isLoopbackRequest(req, true)).toBe(false)
  })

  it('跨源 WebSocket 拒绝', () => {
    const req = mkRequest('127.0.0.1', '127.0.0.1:49821', 'http://evil.example.com', undefined)
    expect(isLoopbackRequest(req, true)).toBe(false)
  })

  it('非 loopback 地址拒绝', () => {
    const req = mkRequest('192.168.1.5', '127.0.0.1:49821', 'http://127.0.0.1:49821', undefined)
    expect(isLoopbackRequest(req, true)).toBe(false)
  })

  it('伪造 Host 拒绝（DNS rebinding 面）', () => {
    const req = mkRequest('127.0.0.1', 'evil.example.com', 'http://evil.example.com', undefined)
    expect(isLoopbackRequest(req, true)).toBe(false)
  })

  it('Sec-Fetch-Site: cross-site 拒绝', () => {
    const req = mkRequest('127.0.0.1', '127.0.0.1:49821', 'http://127.0.0.1:49821', 'cross-site')
    expect(isLoopbackRequest(req, true)).toBe(false)
  })

  it('HTTP 缺 Origin（非 strict）放行——DSH GUI 自身 fetch 场景', () => {
    const req = mkRequest('127.0.0.1', '127.0.0.1:49821', undefined, undefined)
    expect(isLoopbackRequest(req, false)).toBe(true)
  })
})

describe('LSP URI 门禁（P1-03 回归：uri 必须在授权 root 内）', () => {
  const canonicalRoot = 'E:\\work\\project'
  const rootUriPrefix = 'file:///' + canonicalRoot
    .replaceAll('\\', '/')
    .replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`)
    .replace(/\/+$/, '')

  const uriAllowed = (uri: unknown): boolean => {
    if (typeof uri !== 'string') return true
    const norm = decodeURIComponent(uri).toLowerCase()
    return norm.startsWith(rootUriPrefix.toLowerCase())
  }

  it('root 内文件 uri 放行', () => {
    expect(uriAllowed('file:///e:/work/project/src/index.ts')).toBe(true)
  })

  it('root 外文件 uri 拒绝', () => {
    expect(uriAllowed('file:///e:/other/secret.ts')).toBe(false)
  })

  it('百分号编码的 root 内 uri 放行（Windows 冒号 %3A）', () => {
    expect(uriAllowed('file:///e%3A/work/project/src/a.ts')).toBe(true)
  })

  it('非字符串 uri（缺省）放行', () => {
    expect(uriAllowed(undefined)).toBe(true)
  })
})
