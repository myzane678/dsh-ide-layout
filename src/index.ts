/**
 * dsh-ide-layout — host half: workspace-gated filesystem service and the
 * /dsh-ide/* HTTP routes (JSON operations + SSE change stream) on the shared
 * webserver. The browser half (exports "./client") is served by
 * client-modules from the same package's dsh.client declaration.
 * Reference: dsh-web-ui aionui-panel (Apache-2.0), re-implemented.
 */

import { realpath } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { FsService } from './host/fs-service.ts'
import type { GateVerdict, WorkspaceGate } from './host/fs-service.ts'
import { registerPanelRoutes } from './host/routes.ts'
import { PtyService } from './host/pty-service.ts'
import { attachTerminalSocket } from './host/ws-terminal.ts'
import { attachLspSocket } from './host/lsp-service.ts'
import { isLoopbackRequest, rejectUpgrade } from './host/security.ts'

/** Required services: the route registry and the workspace registry. */
export const inject = ['webServer', 'workspaceRegistry']

/**
 * Normalize a path for prefix comparison (Windows case-insensitive).
 */
function normalizeForPrefix(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The canonical prefix check: child must live inside (or equal) the root. */
function isPathInside(root: string, child: string): boolean {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Production gate: canonicalize the requested root and require it to be a
 * registered workspace path (or a subdirectory of one).
 */
function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (root): Promise<GateVerdict> => {
    if (typeof root !== 'string' || root === '') {
      return { ok: false, error: { code: 'workspace-unknown', message: 'empty project root' } }
    }
    let canonical: string
    try {
      canonical = await realpath(root)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    const workspaces = (ctx as unknown as { workspaceRegistry: { list(): Array<{ path: string }> } }).workspaceRegistry.list()
    for (const workspace of workspaces) {
      if (isPathInside(workspace.path, canonical)) {
        return { ok: true, canonical }
      }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not inside a registered workspace' } }
  }
}

/** Model-facing announcement so agents know the IDE panels exist. */
export const IDE_GUIDANCE = '本机已安装 dsh-ide-layout 插件（DSH Web GUI 的 IDE 布局）：左侧为工作区文件树（目录+文件，点击文件在中间编辑器打开），中间为编辑器与终端。数据源为当前会话工作目录的真实文件系统，宿主进程经 /dsh-ide/* 路由提供。用户提到「文件树 / 编辑器 / IDE 布局」时即指本插件。'

/**
 * Mount the fs service and its routes.
 * @param ctx - context carrying webServer and workspaceRegistry.
 */
export function apply(ctx: Context): void {
  const gate = createWorkspaceGate(ctx)
  const fs = new FsService(gate)
  const pty = new PtyService()
  ctx.effect(() => registerPanelRoutes(ctx, fs), 'dsh-ide-layout: /dsh-ide routes')
  // 终端 WebSocket：一个 upgrade 端点，?root= 定位工作区根目录作为 shell cwd。
  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true })
    const dispose = ctx.webServer.registerUpgrade({
      path: '/dsh-ide/ws/terminal',
      handler: (req, socket, head) => {
        // P0-01：WebSocket 与 HTTP 同级来源校验（严格模式：缺失 Origin 直接拒绝）。
        if (!isLoopbackRequest(req as IncomingMessage, true)) {
          rejectUpgrade(socket as Duplex)
          return
        }
        // `ws` 需要真实的 Node 类型；此处为宿主 webserver 的结构化面（结构兼容）做边界转换。
        wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head as Buffer, (ws) => {
          attachTerminalSocket(fs, pty, req as IncomingMessage, ws)
        })
      },
    })
    return () => {
      dispose()
      pty.disposeAll()
      wss.close()
    }
  }, 'dsh-ide-layout: terminal WebSocket')
  // LSP WebSocket：一个 upgrade 端点，?root= 定位工作区根目录（语言服务器
  // 进程以该目录为 cwd 启动）。浏览器半区经此连接走完整 LSP 协议（补全/诊断）。
  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true })
    const dispose = ctx.webServer.registerUpgrade({
      path: '/dsh-ide/ws/lsp',
      handler: (req, socket, head) => {
        // P0-01：与终端 WS 同样的严格来源校验。
        if (!isLoopbackRequest(req as IncomingMessage, true)) {
          rejectUpgrade(socket as Duplex)
          return
        }
        wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head as Buffer, (ws) => {
          attachLspSocket(fs, req as IncomingMessage, ws)
        })
      },
    })
    return () => {
      dispose()
      wss.close()
    }
  }, 'dsh-ide-layout: LSP WebSocket')
}
