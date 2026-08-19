/**
 * 安全的 WebSocket 关闭（所有 /dsh-ide WS 服务共用）。
 *
 * ws close reason 有 123 字节协议上限：超长时 ws 库抛 RangeError，而关闭调用
 * 常发生在子进程事件回调 / catch 块里（无 try/catch 兜底），会变成
 * uncaughtException → Node 宿主进程终止 → DSH Desktop 整体闪退。
 * 按 UTF-8 字节数截断到 121 字节以内再发送（多字节字符按码元截断，
 * 残留的孤立代理项在 ws 编码时会被替换为 U+FFFD，不会抛错）。
 */
import type { WebSocket } from 'ws'

export function closeWs(ws: WebSocket, code: number, reason: string): void {
  let safe = reason
  while (Buffer.byteLength(safe, 'utf8') > 121) safe = safe.slice(0, -1)
  ws.close(code, safe)
}
