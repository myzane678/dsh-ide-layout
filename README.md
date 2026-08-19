# dsh-ide-layout

DSH（DeepSeek Harness）Web GUI 的 IDE 布局插件：左侧工作区文件树，中间 CodeMirror 6 编辑器 + xterm 终端，右侧 agent 对话。基于 DSH Web GUI 的会话工作目录真实文件系统，宿主进程经 `/dsh-ide/*` 路由提供服务。

> 参考实现：dsh-web-ui / aionui-panel（Apache-2.0），本插件为其重新实现。

## 功能特性

### 编辑器（CodeMirror 6）
- 语法高亮：JavaScript / TypeScript / JSX / JSON / Markdown / Python / HTML / CSS / YAML / XML / SQL / Java / C/C++ / Rust / Go / PHP / Vue / SCSS / LESS / TOML / Batch（.cmd/.bat）/ PowerShell / Shell
- 行号、代码折叠、状态栏（语言 / 行列 / 诊断数）
- 自动补全（LSP）、诊断波浪线、悬停提示
- F12 / Ctrl+点击 跳转定义、F2 重命名、Shift+Alt+F 格式化
- 右键快速修复、Tab 接受补全
- 保存：Ctrl+S 快捷键 + tab 栏「💾 保存」按钮（有未保存更改时可用，状态栏反馈）
- 字号缩放：Ctrl/Cmd + 滚轮调整编辑器字号（9–24px，localStorage 记忆，状态栏显示当前字号）

### LSP（语言服务器协议）
> 仅对支持的语言启用（P2-04）：语法高亮覆盖 23 种格式，但 LSP 智能能力（补全/诊断/悬停/跳转/重命名等）只面向以下两种语言，其余语言为纯高亮。

- TypeScript / JavaScript：`typescript-language-server` 5.3.0
- Python：`pyright` 1.1.413
- 宿主进程为每个 WebSocket 连接启动一个语言服务器子进程（stdio ↔ WS 透传）
- ⚠️ Electron 宿主必须设置 `ELECTRON_RUN_AS_NODE=1`
- 终端 / LSP WebSocket 与 HTTP 路由同级校验：仅接受本机 loopback + 同源 Origin 的连接

### 文件树
- 左侧栏 flex 流嵌入布局（不覆盖、不遮挡），常驻主视图
- 目录懒加载、刷新不闪烁
- 右键菜单：新建 / 重命名 / 删除 / 复制路径 / 资源管理器显示
- 顶部拖拽手柄调整高度（localStorage 记忆）
- 右上角小图标切换 Git / 问题视图（问题图标带诊断计数角标）

### 终端
- xterm 5.5 + node-pty，每个 root 一个 shell
- 拖拽调整高度（DOM 直改 + rAF 实时 fit，无抖动）
- 30s 重连宽限

### Git 面板
- status / diff / stage / unstage / commit / discard / log + 提交历史 diff
- **嵌套仓库发现**：工作区根不是 Git 仓库时，自动扫描子目录中的仓库并在下拉框中选择（如多插件仓库 `dsh-plugins` 下的各插件）
- 仓库选择器完整显示仓库名，分支名超长自动省略

### 问题面板
- 聚合所有 LSP 诊断，按文件分组 + 行号排序 + 严重度彩色标记，点击跳转

### 运行
- node / python / pwsh 执行 + 输出面板（60s 超时 + 200KB 上限）
- 首次运行需确认（localStorage 记忆）；并发上限 3 个进程

### 安全
- **来源校验**：HTTP / SSE / 终端 WS / LSP WS 统一 loopback + Host + Origin 校验（WebSocket 严格要求同源 Origin，拒绝缺失/跨源/伪造 Host/DNS rebinding）
- **工作区门控**：所有文件操作经 `realpath()` 校验在工作区内；写/改名/删除前二次 canonical 校验（symlink / reparse point 缓解）
- **Git 边界**：git 操作要求所选 root 即仓库根，拒绝从子目录上溯操作父仓库；`.git` 路径拒绝写入
- **资源上限**：LSP 并发 8 连接、单帧 4MB、请求 10s 超时；运行并发 3；终端按 root 隔离
- **数据保护**：大文件截断后只读禁保存；dirty tab 关闭/切 root 有确认守卫；跨文件编辑带 mtime 冲突检测

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
└── host/                 # 宿主服务：fs-service / git / lsp-service / pty-service / routes / ws-terminal / security
```

- **宿主半区**（exports `.`）：workspace 门控文件系统服务、`/dsh-ide/*` HTTP 路由（JSON 操作 + SSE 变更流）、终端 / LSP WebSocket
- **浏览器半区**（exports `./client`）：经 `dsh.client` 声明加载到 Web GUI

## 安装与构建

### 一键安装（DSH 插件 CLI）

在 DSH 中通过插件命令从 GitHub 安装，安装时自动执行 `prepare` 构建（无需手动 build）：

```bash
dsh plugin --profile desktop add "dsh-ide-layout@git+https://github.com/myzane678/dsh-ide-layout.git"
```

> **⚠️ 重要**：本插件**不是纯静态前端插件**——它依赖本地宿主能力（workspace 门控文件系统、`/dsh-ide/*` 路由、终端/LSP 子进程、脚本运行）。必须安装在 **desktop profile**（web profile 只有浏览器半区，缺少宿主服务无法工作）。

安装后重启 DSH（或刷新 GUI 页面）生效。之后更新插件只需在 profile 目录执行：

```bash
pnpm update dsh-ide-layout
```

### 卸载 / 回退

```bash
dsh plugin --profile desktop remove dsh-ide-layout
```

回退到上一版本：在 `~/.dsh/profiles/desktop/package.json` 中把依赖改回旧版本号（或 git 提交哈希），然后 `pnpm install` + 重启 DSH。插件只读不写自身之外的状态，卸载不会影响已有文件与仓库。

### 本地开发构建

```bash
pnpm install
pnpm build    # tsc -b && tsdown
```

开发监听模式：`pnpm watch`

### 测试

```bash
pnpm test        # vitest 单测（来源校验 / URI 门禁 / tab 关闭规则）
pnpm typecheck   # tsc 类型检查
```

## 更新日志

版本与变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
