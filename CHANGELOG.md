# Changelog

本项目版本与更新记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 安全修复（审查整改，2026-08-18）

根据独立安全审查（`dsh-ide-layout-审查整改清单.md`）完成 18 项整改：

- **P0-01** 终端/LSP WebSocket 接入与 HTTP 同级的来源校验（loopback + Host + Origin，严格要求同源 Origin，拒绝缺失/跨源/伪造 Host/DNS rebinding）
- **P0-02** PTY 改为按 canonical root 独立管理（`Map<root, handle>`）+ 连接引用计数（最后连接断开才启动回收计时）+ 禁止向新连接重放历史 transcript
- **P0-03** Git 操作要求所选 root 即仓库根（`repoTopLevel` realpath 校验），拒绝从子目录上溯操作父仓库
- **P1-01** 文件写/改名/删除前二次 canonical 校验（symlink / reparse point 缓解；如实标注无法完全消除 TOCTOU 竞态）
- **P1-02** 脚本运行接入首次确认（localStorage 记忆）+ 并发上限 3 进程
- **P1-03** LSP 增加 URI 门禁（文件 URI 必须在授权工作区内）、连接上限 8、单帧 4MB、请求 10s 超时、初始化失败主动重连（不再保留「OPEN 但未初始化」假连接）
- **P1-04** 大文件截断后只读并禁止保存（防尾部数据覆盖丢失）
- **P1-05** dirty tab 关闭 / 关闭编辑区 / 切换工作区均有保存确认守卫
- **P1-06** 异步打开文件改用函数式 update 合并（防陈旧快照覆盖并发打开的文件）
- **P1-07** 跨文件 WorkspaceEdit 写入携带 baseMtime 冲突检测，拒绝截断/工作区外目标
- **P2-01** 修复关闭活动中间 tab 时 activeTabId 指向已移除 tab 的问题
- **P2-02** 宿主 DOM 重建后自动重新挂载面板（`waitForElement` 持续监听）；sidebar 宽度实时读取
- **P2-03** 文件树 / Git 面板异步响应增加 root/repo 代际校验（generation token）
- **P2-04** LSP 客户端仅对支持语言创建（md/go/rust 等不再误拿 TS client）
- **P2-05** 诊断缓存随 root 切换 / 文件关闭清理
- **P2-06** `pnpm-workspace.yaml` 的 `allowBuilds.node-pty` 改为显式布尔值 `true`；`package.json` 锁定 `packageManager: pnpm@11.7.0`
- **P2-07** README 补充 desktop profile 必需说明、卸载/回退步骤、测试命令
- **P2-08** 新增 vitest 单测（来源校验 / LSP URI 门禁 / tab 关闭规则，17 项）+ GitHub Actions CI（typecheck → test → build）

### 功能

- 侧边栏改为文件树常驻主视图 + 右上角小图标切换 Git/问题（问题图标带诊断计数角标）
- 编辑器新增 💾 保存按钮（有未保存更改时可用）
- 编辑器 Ctrl/Cmd + 滚轮调整字号（9–24px，localStorage 记忆，状态栏显示）
- Git 面板支持嵌套仓库发现与选择（工作区根不是 Git 仓库时自动扫描子目录仓库）
- 语法高亮扩展：YAML / XML / SQL / Java / C/C++ / Rust / Go / PHP / Vue / SCSS / LESS / TOML / Batch（.cmd/.bat，自写 StreamParser）/ PowerShell / Shell（共 23 种格式）
- Markdown 高亮补充标题/强调/链接/引用/删除线配色
- 一键安装：`dsh plugin --profile desktop add "dsh-ide-layout@git+https://github.com/myzane678/dsh-ide-layout.git"`（`prepare` 自动构建）

## [0.1.0] - 2026-08-18

- 初始发布：DSH Web GUI IDE 布局插件
- 文件树（flex 流嵌入、懒加载、右键菜单、拖拽调高）
- CodeMirror 6 编辑器 + LSP（TypeScript / Python，补全/诊断/悬停/跳转/重命名/格式化/快速修复）
- xterm 终端（node-pty）+ Git 面板 + 问题面板 + 脚本运行输出
