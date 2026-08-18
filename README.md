# dsh-ide-layout

DSH（DeepSeek Harness）Web GUI 的 IDE 布局插件：左侧工作区文件树，中间 CodeMirror 6 编辑器 + xterm 终端，右侧 agent 对话。基于 DSH Web GUI 的会话工作目录真实文件系统，宿主进程经 `/dsh-ide/*` 路由提供服务。

> 参考实现：dsh-web-ui / aionui-panel（Apache-2.0），本插件为其重新实现。

## 功能特性

### 编辑器（CodeMirror 6）
- 语法高亮：JavaScript / TypeScript / Python / HTML / CSS / Markdown / JSON
- 行号、代码折叠、状态栏（语言 / 行列 / 诊断数）
- 自动补全（LSP）、诊断波浪线、悬停提示
- F12 / Ctrl+点击 跳转定义、F2 重命名、Shift+Alt+F 格式化
- 右键快速修复、Tab 接受补全

### LSP（语言服务器协议）
- TypeScript：`typescript-language-server` 5.3.0
- Python：`pyright` 1.1.413
- 宿主进程为每个 WebSocket 连接启动一个语言服务器子进程（stdio ↔ WS 透传）
- ⚠️ Electron 宿主必须设置 `ELECTRON_RUN_AS_NODE=1`

### 文件树
- 左侧栏 flex 流嵌入布局（不覆盖、不遮挡）
- 目录懒加载、刷新不闪烁
- 右键菜单：新建 / 重命名 / 删除 / 复制路径 / 资源管理器显示
- 顶部拖拽手柄调整高度（localStorage 记忆）

### 终端
- xterm 5.5 + node-pty，每个 root 一个 shell
- 拖拽调整高度（DOM 直改 + rAF 实时 fit，无抖动）
- 30s 重连宽限

### Git 面板
- status / diff / stage / unstage / commit / discard / log
- 侧边栏「文件 | Git | 问题」Tab 切换

### 问题面板
- 聚合所有 LSP 诊断，按文件分组 + 行号排序 + 严重度彩色标记，点击跳转

### 运行
- node / python / pwsh 执行 + 输出面板（60s 超时 + 200KB 上限）

## 架构

```
src/
├── index.ts              # 宿主半区入口：workspace 门控 fs 服务 + /dsh-ide/* 路由
├── client/               # 浏览器半区（exports "./client"）
│   ├── mount.tsx         # 挂载 IDE 面板
│   ├── layout.ts         # 布局逻辑
│   ├── store.ts          # 状态管理
│   ├── lsp-client.ts     # LSP WebSocket 客户端
│   ├── api.ts            # 文件操作 API
│   ├── xterm-css.ts      # 终端主题
│   └── components/       # EditorPane / FileTree / GitPanel / ProblemsPanel / TerminalPane
├── core/                 # 共享类型
└── host/                 # 宿主服务：fs-service / git / lsp-service / pty-service / routes / ws-terminal
```

- **宿主半区**（exports `.`）：workspace 门控文件系统服务、`/dsh-ide/*` HTTP 路由（JSON 操作 + SSE 变更流）、终端 / LSP WebSocket
- **浏览器半区**（exports `./client`）：经 `dsh.client` 声明加载到 Web GUI

## 安装与构建

```bash
pnpm install
pnpm build    # tsc -b && tsdown
```

开发监听模式：`pnpm watch`

## 许可证

[MIT](LICENSE)
