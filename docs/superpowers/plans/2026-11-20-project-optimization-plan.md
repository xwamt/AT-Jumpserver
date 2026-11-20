# AT JumpServer Terminal 项目优化任务计划

> **面向执行者 / Agent**：可配合 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务逐项推进。所有任务使用 `- [ ]` 复选框跟踪进度。

**基线分支与状态：**
- 分支：`feat/jumpserver-5.0-connect-alignment`
- 前置已完成：移除资产行内悬停 `"JumpServer: 连接终端"` 菜单项（`package.json` + `test/package.manifest.test.ts`）
- 基线验证：`npm run typecheck` 通过、`vitest run` 63 个测试文件 / 759 条用例全部通过、`npm run build` 通过。

---

## 0. 执行原则与架构硬约束

1. **TDD 纪律**：每个修复/改造任务先编写复现或预期断言测试 → 确认失败（RED）→ 实施代码改动 → 测试全绿（GREEN）。
2. **SFTP 懒加载红线**：严禁在「连接终端」时预先建立 SFTP WebSocket 会话；SFTP 连接必须仅在用户显式操作文件树/传输或 MCP 调用 SFTP 工具时触发。
3. **Bundle 边界红线**：保持 `dist/extension.js` 与 `dist/mcpRuntime.js`、`dist/policy-runtime.js` 拆包隔离（由 `test/package.policyBundle.test.ts` 等测试守卫），不得把 `@at-series/mcp-hub` 或 `@at-series/command-policy` 运行时静态打入主入口。
4. **本地化同步约束**：每次修改 `package.nls.zh-cn.json` 或 `l10n/bundle.l10n.zh-cn.json` 后，必须执行 `npm run sync:l10n` 同步 `zh-hans` 与 `zh` 副本，确保 `test/i18n/nls.test.ts` 通过。
5. **分批提交与阶段门禁**：建议按 Phase 1 → 4 分批次提交 Commit。每个 Phase 完成后运行统一验证门禁：
   ```bash
   npm run typecheck && npm test && npm run build
   ```

---

## 1. 任务总览表（Overview Matrix）

| 编号 | 任务名称 | 优先级 | 类型 | 核心涉及文件 | 状态 |
| ---- | -------- | ------ | ---- | ------------ | ---- |
| Task 1.1 | 修复堡垒机节点悬停长文本遮挡 | P0 | UI / Bug | `package.json`, `test/package.manifest.test.ts` | [x] |
| Task 1.2 | 修复终端首屏初始尺寸 `resize` 丢失（默认 `80x24`） | P0 | Bug | `src/jumpserver/JumpServerSession.ts`, `test/jumpserver/JumpServerSession.test.ts` | [x] |
| Task 1.3 | 修复终端状态栏中文断连指示灯误判、统一状态国际化并增强状态栏 | P0 | Bug / UI | `webview/terminal/*`, `src/webview/TerminalPanel.ts`, `src/jumpserver/JumpServerSession.ts`, `l10n/*` | [x] |
| Task 1.4 | SFTP 断连自动重建会话 & 增加客户端心跳保活 | P0 | 稳定性 | `src/sftp/JumpServerSftpManager.ts`, `src/sftp/JumpServerSftpSession.ts`, `test/sftp/*` | [x] |
| Task 1.5 | 补齐配置变更与缓存失效联动（Pool / 能力探测 / 终端热更新） | P0 | Bug / 稳定性 | `src/jumpserver/JumpServerClientPool.ts`, `src/extension.ts`, `src/webview/JumpServerConfigPanel.ts` | [x] |
| Task 1.6 | 修复 SFTP 编辑状态栏隐藏竞态、消除同步 IO 与死代码 | P0 | Bug | `src/sftp/SftpEditSessionManager.ts`, `test/sftp/SftpEditSessionManager.test.ts` | [x] |
| Task 1.7 | 修复 MCP `terminalQueues` 内存条目泄漏 | P0 | 稳定性 | `src/agent/JumpServerAgentToolService.ts`, `test/agent/JumpServerAgentToolService.test.ts` | [x] |
| Task 2.1 | 规范命令面板入口 + 支持全局 QuickPick 搜索直连资产 | P1 | UI / 交互 | `package.json`, `src/extension.ts`, `test/extension/ExtensionCommands.test.ts` | [x] |
| Task 2.2 | 补齐 SFTP 远程文件树交互体验（占位点击 & 高频操作） | P1 | UI / 交互 | `src/tree/SftpTreeProvider.ts`, `src/tree/SftpTreeItems.ts`, `src/extension.ts`, `package.json` | [x] |
| Task 2.3 | 资产树图标体系、多账号选择与 `@INPUT` 提示国际化 | P1 | UI / 交互 | `src/tree/TreeItems.ts`, `src/tree/BastionTreeItem.ts`, `src/jumpserver/JumpServerClient.ts`, `src/webview/TerminalPanel.ts` | [x] |
| Task 2.4 | 优化堡垒机配置面板体验（密码提示 / 测试连接 / 按钮状态） | P1 | UI / 交互 | `src/webview/JumpServerConfigPanel.ts`, `webview/jumpserver-config/*` | [x] |
| Task 3.1 | 资产树节点索引缓存（大资产库展开性能优化） | P2 | 性能 | `src/tree/JumpServerTreeProvider.ts`, `test/tree/JumpServerTreeProvider.test.ts` | [ ] |
| Task 3.2 | SFTP 大文件分块流式上传（避免整文件读入内存） | P2 | 性能 | `src/sftp/JumpServerSftpManager.ts`, `src/sftp/JumpServerSftpSession.ts`, `test/sftp/*` | [ ] |
| Task 4.1 | 清理 l10n 生产包测试脏数据并加固 `nls.test.ts` 守卫 | P2 | 工程卫生 | `l10n/bundle.l10n.zh-cn.json`, `test/i18n/nls.test.ts` | [ ] |
| Task 4.2 | 构建脚本去重与历史残留文件/目录清理 | P3 | 工程卫生 | `package.json`, 工作区历史 `.vsix` / `.tmp-*` / `.worktrees` | [ ] |
| Task 4.3 | 巨石文件渐进式拆分（`JumpServerClient.ts` & `extension.ts`） | P3 | 架构 | `src/jumpserver/*`, `src/extension.ts`, `src/commands/*` | [ ] |

---

## 2. Phase 1：缺陷修复与连接稳定性（P0，建议优先执行）

### Task 1.1：修复堡垒机节点悬停长文本遮挡
- [x] **现状与根因**：
  - `package.json`（第 55-58 行）中 `jumpserverManager.refreshBastion` 未声明 `icon`，但第 181-185 行将其注册为 `"group": "inline@1"`。
  - 悬停在堡垒机根节点（`src/tree/BastionTreeItem.ts` 第 5-13 行）时，VS Code 会直接把 `"JumpServer: 刷新此堡垒机"` 渲染在行内，遮挡堡垒机域名 `description`。
- [x] **改造方案**：
  1. 在 `package.json` 中为 `jumpserverManager.refreshBastion` 补充 `"icon": "$(refresh)"`。
  2. 顺带评估 `editBastion` / `removeBastion` 是否需要补充图标以便右键/快捷操作辨识（二者在 `2_manage` 组非 `inline`，可按需补充 `$(edit)` / `$(trash)`）。
  3. 在 `test/package.manifest.test.ts` 增加守卫测试：所有声明在 `inline*` 分组的 `view/item/context` 命令，其对应的 `contributes.commands` 条目必须配置非空 `icon`，防止未来新增行内操作时再次出现文字遮挡。
- [x] **涉及文件**：`package.json`、`test/package.manifest.test.ts`。
- [x] **验收标准**：`npm test` 中新增守卫通过；在 UI 中悬停堡垒机根节点仅显示刷新图标。

### Task 1.2：修复终端首屏初始尺寸 `resize` 丢失（默认 `80x24` 问题）
- [x] **现状与根因**：
  - 前端 `webview/terminal/index.ts`（第 118 行）在页面加载首帧调用 `scheduleFit(true)` 并立即向扩展发送 `{ type: 'ready', rows, cols }`。
  - 此时 KoKo WebSocket 握手通常尚未完成（`this.socket` 为 `undefined`），而 `src/jumpserver/JumpServerSession.ts`（第 293-304 行）的 `resize(rows, cols)` 在 `!this.socket || this.unavailableReason` 时直接 `return`，**没有保存 `rows`/`cols`**。
  - 随后收到 KoKo `CONNECT` 帧时，`JumpServerSession.ts`（第 430-435 行）仍以写死的默认值 `cols: 80, rows: 24` 发送 `TERMINAL_INIT`，导致首屏输出换行错乱，必须手动拖拽面板尺寸才能恢复。
- [x] **改造方案**：
  1. 修改 `JumpServerSession.resize(rows, cols)`：
     ```ts
     resize(rows: number, cols: number): void {
       if (rows <= 0 || cols <= 0 || this.unavailableReason) {
         return;
       }
       this.rows = rows;
       this.cols = cols;
       if (!this.socket) {
         return;
       }
       this.socket.send(JSON.stringify({
         id: '',
         type: 'TERMINAL_RESIZE',
         data: JSON.stringify({ cols, rows })
       }));
     }
     ```
  2. 检查 `TerminalPanel` 在 `connect()` 或 `reconnect()` 期间调用 `resize` 时的行为，确保 `ready` 在连接建立前到达也能把最终视口大小带入 `TERMINAL_INIT`。
- [x] **涉及文件**：`src/jumpserver/JumpServerSession.ts`、`test/jumpserver/JumpServerSession.test.ts`。
- [x] **验收标准**：在 `test/jumpserver/JumpServerSession.test.ts` 新增单测，验证在 `connect()` 完成前调用 `session.resize(40, 160)`，待 socket 打开并收到 `CONNECT` 控制消息后，发送给 KoKo 的 `TERMINAL_INIT` 的 `data` 为 `{"cols":160,"rows":40,"code":""}`。

### Task 1.3：修复终端状态栏中文断连指示灯误判、统一状态国际化并增强状态栏信息
- [x] **现状与根因**：
  - `webview/terminal/clipboard.ts`（第 106-115 行）的 `resolveTerminalStatusClass(payload)` 仅按英文 `'Connected'` 与 `'disconnected'` 关键字判定颜色状态，而 `src/webview/TerminalPanel.ts`（第 280、401-404 行）在主动断开与空闲断开时发送 `t('Disconnected')` / `t('Disconnected after ...')`（中文为“已断开连接”），导致中文界面断连后状态灯停留在黄色（`connecting`）而非红色（`disconnected`）。
  - `src/jumpserver/JumpServerSession.ts`（第 103、187、220、437、497 行）的连接状态文案（`'Loading asset'`、`'Creating connection token'`、`'Opening KoKo terminal'`、`'Connected'`、`'Disconnected'`）为硬编码英文，与 `TerminalPanel.ts` 的 `t(...)`（`'正在启动…'`、`'正在重新连接…'`、`'已断开连接'`）中英混显。
  - `src/webview/TerminalPanel.ts`（第 70 行）顶栏右侧 `.terminal-host` 硬编码显示 `"xterm.js"`，信息价值低且断连后缺少直接点击重连入口。
- [x] **改造方案**：
  1. **状态协议结构化**：扩展 `TerminalPanel` 发往 webview 的状态消息格式为：
     `{ type: 'status', state: 'connecting' | 'connected' | 'disconnected', payload: string }`；
     `webview/terminal/index.ts` 优先依据 `message.state` 切换状态灯 CSS 类，同时保留 `resolveTerminalStatusClass` 的字符串回退逻辑以兼容现有单元测试（并补充中文断连关键字匹配）。
  2. **统一状态文案国际化**：在 `JumpServerSession.ts` 与 `TerminalPanel.ts` 中将连接阶段与结果文案统一接入 `t(...)`（注意检查 `TerminalPanel.ts` 第 419 行 `message.startsWith('Disconnected')` 判据同步改为基于事件回调或标准化状态，避免 i18n 后判断失效！），并补齐 `l10n/bundle.l10n.zh-cn.json` 与 `npm run sync:l10n`。
  3. **增强顶栏交互**：将 `TerminalPanel.ts` 顶栏右侧 `.terminal-host` 替换为资产标识（如 `${asset.address || asset.name} · ${connectionKindLabel(connectionKind)}`），并在 `disconnected` 状态时在状态栏显示可点击的“重新连接”按钮（`postMessage({ type: 'reconnect' })` → `TerminalPanel` 调用 `this.reconnect()`）。
- [x] **涉及文件**：`webview/terminal/clipboard.ts`、`webview/terminal/index.ts`、`webview/terminal/index.css`、`src/webview/TerminalPanel.ts`、`src/jumpserver/JumpServerSession.ts`、`l10n/bundle.l10n.zh-cn.json`、`test/webview/TerminalClipboard.test.ts`、`test/webview/TerminalPanel.test.ts`、`test/jumpserver/JumpServerSession.test.ts`、`test/i18n/nls.test.ts`。
- [x] **注意事项**：`TerminalPanel.ts` 第 419 行通过 `message.startsWith('Disconnected')` 判断被动断连并清空 `currentTokenId` / `terminalContext`，改造状态文本 i18n 时务必先保留明确的状态码或结构化回调，避免断连后 `connected` 状态未复位。
- [x] **验收标准**：中文环境下断连后状态灯变为红色且文字全中文；状态栏显示当前资产 IP/协议并支持点击按钮重连；相关单测与 `nls.test.ts` 全绿。

### Task 1.4：SFTP 断连自动重建会话 & 增加客户端心跳保活
- [x] **现状与根因**：
  - `src/sftp/JumpServerSftpManager.ts`（第 248-251 行）的 `ensureSession` 仅检查 `if (connection.session) return connection.session;`。一旦底层 `JumpServerSftpSession` 因网络中断或空闲被服务端关闭触发 `handleClose`（`src/sftp/JumpServerSftpSession.ts` 第 529-536 行），`this.connected` 变为 `false`，但 `connection.session` 对象依然留在 Map 中，后续所有文件列表、上传、下载操作均会永久报错 `SFTP connection is not available.`。
  - `JumpServerSftpSession` 仅被动响应服务端 `PING`（第 451-454 行），不像 `JumpServerSession`（第 356-374 行，20s 间隔 / 15s 超时）具备主动 WS `ping`/`pong` 心跳，经过 60s 反代空闲切断后易形成半开假死连接。
- [x] **改造方案**：
  1. 在 `src/sftp/JumpServerSftpManager.ts` 的 `JumpServerSftpSessionLike` 接口增加可选方法 `isConnected?(): boolean`（设为可选以兼容 `test/sftp/JumpServerSftpManager.test.ts` 第 31-47 行的 mock 对象）。
  2. 修改 `ensureSession`：
     ```ts
     if (connection.session) {
       if (connection.session.isConnected?.() !== false) {
         return connection.session;
       }
       connection.session.dispose();
       connection.session = undefined;
     }
     ```
  3. 在 `src/sftp/JumpServerSftpSession.ts` 增加与 `JumpServerSession` 一致的主动 WS `ping`/`pong` 心跳保活（`HEARTBEAT_INTERVAL_MS = 20_000`、`HEARTBEAT_TIMEOUT_MS = 15_000`，定时器使用 `unref?.()`），当心跳超时时调用 `handleClose` 并 `terminate()` 释放半开连接；在 `dispose()` 和 `handleClose()` 中停止心跳。
  4. 注意复用令牌逻辑：`JumpServerSftpSession.connect()` 内部会优先取 `TerminalPanel.getReusableToken`；若原连接断线重连但终端 token 已失效，`JumpServerSftpSession.ts` 第 163-178 行已有回退重新申请 `web_sftp` 专用 token 的机制，需在测试中覆盖该分支。
- [x] **涉及文件**：`src/sftp/JumpServerSftpManager.ts`、`src/sftp/JumpServerSftpSession.ts`、`test/sftp/JumpServerSftpManager.test.ts`、`test/sftp/JumpServerSftpSession.test.ts`。
- [x] **验收标准**：新增单测验证 ① `isConnected()` 返回 `false` 时 `JumpServerSftpManager` 自动销毁旧会话并新建连接；② `JumpServerSftpSession` 在心跳超时无 `pong` 时自动断连并拒绝挂起请求、释放 socket。

### Task 1.5：补齐配置变更与缓存失效联动
- [x] **现状与根因**：
  - `src/jumpserver/JumpServerClientPool.ts`（第 99-101 行）的 `clientCacheIdentity` 仅拼接 `baseUrl`、`username`、`password`、`verifyTls`，未纳入 `kokoBearerHandshake`，在 VS Code 设置中切换该开关时，已入池的客户端不会重建。
  - 在 `src/extension.ts`（第 315-320 行）删除堡垒机，或在 `src/webview/JumpServerConfigPanel.ts`（第 68-80 行）编辑修改堡垒机 URL 后，均未调用 `clearKokoCapabilityCache(bastionId)`（`src/jumpserver/kokoCapability.ts` 第 17-25 行），可能沿用旧地址探测到的 `cookieLess` 能力结果。
  - 修改终端设置（字体大小、字体族、语义高亮、空闲超时分钟数）后，已打开的 `TerminalPanel` 不会感知并动态更新。
- [x] **改造方案**：
  1. 更新 `clientCacheIdentity(settings, options)`，将 `options?.kokoBearerHandshake ? '1' : '0'` 纳入缓存键。
  2. 在删除堡垒机命令（`src/extension.ts` `removeBastion`）和保存/编辑堡垒机配置（`JumpServerConfigPanel.ts` 或 `JumpServerConfigManager.saveBastion`）时清理 `clearKokoCapabilityCache(bastionId)`，并在 URL/凭据变化时确保对应的 `clientPool` 条目被刷新。
  3. （可选增强）在 `TerminalPanel` 暴露静态配置同步方法并订阅 `vscode.workspace.onDidChangeConfiguration`（过滤 `jumpserverManager` 前缀），实时将新的 `fontSize`/`fontFamily`/`semanticHighlight` 推送到存活 webview 并在面板重新评估空闲定时器。
- [x] **涉及文件**：`src/jumpserver/JumpServerClientPool.ts`、`src/extension.ts`、`src/webview/JumpServerConfigPanel.ts`、`src/webview/TerminalPanel.ts`、`test/jumpserver/JumpServerClientPool.test.ts`、`test/extension/ExtensionCommands.test.ts`。
- [x] **验收标准**：切换 `kokoBearerHandshake` 时池中客户端触发重建；编辑或删除堡垒机时清理对应 `kokoCapability` 缓存；单测全绿。

### Task 1.6：修复 SFTP 编辑状态栏隐藏竞态、消除同步 IO 与死代码
- [x] **现状与根因**：
  - `src/sftp/SftpEditSessionManager.ts`（第 328-330 行）在 `state === 'idle'` 时设置 2000ms `setTimeout(() => statusBarItem.hide(), 2000)`，未保存并清理之前的定时器句柄。若用户 2 秒内连续保存，前一次定时器会把后一次正在展示的“正在上传”或“同步失败”状态栏误隐藏。
  - `src/sftp/SftpEditSessionManager.ts`（第 258 行）的 `verifyUploadedContent` 使用同步 `statSync(session.localUri.fsPath)` 阻塞扩展宿主事件循环。
  - `src/sftp/SftpEditSessionManager.ts`（第 338-340 行）的 `promptUnsyncedClose` 定义在 `SftpEditUi` 接口中但从未被调用，属于未接入的死代码。
- [x] **改造方案**：
  1. 在 `createVscodeSftpEditUi` 闭包中维护 `let hideTimer: ReturnType<typeof setTimeout> | undefined;`，每次进入 `showStatus` 先 `clearTimeout(hideTimer)` 并置空，再在 `state === 'idle'` 时重新设定。
  2. 将 `verifyUploadedContent` 改为 `async` 并改用 `await stat(session.localUri.fsPath)`（来自 `node:fs/promises`）。
  3. 明确处理 `promptUnsyncedClose`：若当前关闭文档策略已确定为 `closeSession` 自动 flush + 等待上传，则从 `SftpEditUi` 接口、实现与 mock 中移除该死代码（或若需交互确认则在 `closeSession` 上传失败时真正接入弹窗提示）。
- [x] **涉及文件**：`src/sftp/SftpEditSessionManager.ts`、`test/sftp/SftpEditSessionManager.test.ts`。
- [x] **验收标准**：新增状态栏定时器防抖竞态单元测试（`idle` → 1s 后触发 `uploading` → 再过 1s 不应隐藏状态栏）；移除同步 `statSync`。

### Task 1.7：修复 MCP `terminalQueues` 内存条目泄漏
- [x] **现状与根因**：
  - `src/agent/JumpServerAgentToolService.ts`（第 55、68-79 行）使用 `terminalQueues = new Map<string, Promise<unknown>>()` 按 `terminalId` 串行化 MCP 工具命令，但任务完成或终端关闭后从未从 Map 中删除 key，长生命周期会话下会持续累积。
- [x] **改造方案**：
  1. 在 `enqueueTerminal` 的尾 Promise 清理阶段判断：`if (this.terminalQueues.get(terminalId) === tail) { this.terminalQueues.delete(terminalId); }`。
  2. 在 `JumpServerAgentToolService` 构造函数中订阅 `dependencies.terminalContext.onDidRemoveContext?.((terminalId) => this.terminalQueues.delete(terminalId))`（可选链兼容仅提供部分方法的测试替身）作为兜底释放。
- [x] **涉及文件**：`src/agent/JumpServerAgentToolService.ts`、`test/agent/JumpServerAgentToolService.test.ts`。
- [x] **验收标准**：单测验证并发命令仍严格串行执行，且全部完成后 `terminalQueues` 不残留已结束条目。

---

## 3. Phase 2：前端 UI 与日常操作体验打磨（P1）

### Task 2.1：规范命令面板入口 + 支持全局 QuickPick 搜索直连资产
- [x] **现状与根因**：
  - `package.json`（第 247-252 行）的 `commandPalette` 仅隐藏了 `jumpserverManager.setAssetTrust`。
  - 但 `copyHostIp`、`sftp.download`、`sftp.preview`、`sftp.edit`、`sftp.delete`、`sftp.rename`、`sftp.copyPath` 均强依赖树节点 `item` 入参（`src/extension.ts` 第 390-546 行），从命令面板调用只会静默无反应或报错；`jumpserverManager.connect`（第 372-375 行）无 `item` 时也直接 `return`。
- [x] **改造方案**：
  1. 参考姊妹工程 `at-terminal-series/package.json`（第 352-380 行），将仅面向树节点右键的单条目命令（`copyHostIp`、`sftp.download`、`sftp.preview`、`sftp.edit`、`sftp.delete`、`sftp.rename`、`sftp.copyPath`）加入 `menus.commandPalette` 并设置 `"when": "false"`。
  2. 增强 `jumpserverManager.connect`：当未传入 `item`（用户通过 `Cmd+Shift+P` 或快捷键触发）时，从 `configManager.listCachedAssets()` 与 `listBastions()` 读取资产清单，弹出支持模糊匹配的 `vscode.window.showQuickPick`（展示资产名称、IP、连接协议、所属堡垒机与分组路径），选中后直接打开终端并绑定 SFTP。
- [x] **涉及文件**：`package.json`、`src/extension.ts`、`l10n/bundle.l10n.zh-cn.json`、`test/package.manifest.test.ts`、`test/extension/ExtensionCommands.test.ts`。
- [x] **验收标准**：`Cmd+Shift+P` 不再出现无效的树上下文命令；执行 `"JumpServer: 连接终端"` 可搜索并直连任意已缓存资产。

### Task 2.2：补齐 SFTP 远程文件树交互体验
- [x] **现状与根因**：
  - `src/tree/SftpTreeProvider.ts`（第 46-50 行）的 `pending` 提示节点（“Files for {name} connect on first refresh”）没有绑定 `command`，用户点击提示行没有任何反应，只能找右上角刷新按钮。
  - `src/tree/SftpTreeItems.ts`（第 33-43 行）的文件节点未绑定默认点击动作；与 `at-terminal-series` 相比，SFTP 视图还缺少直接跳转到指定远程路径（`goToPath`）、新建空文件（`newFile`）及终端切换目录（`cdToDirectory`）能力。
- [x] **改造方案**：
  1. 在 `SftpTreeProvider.ts` 为 `pending` 占位项绑定 `command: { command: 'jumpserverManager.sftp.refresh', title: t('Refresh') }`，支持点击提示行立即触发 SFTP 连接并加载目录。
  2. 为 `SftpFileTreeItem` 增加单击预览动作（`command: { command: 'jumpserverManager.sftp.preview', ... }`，需避开 `disconnected` 只读快照状态或给出明确提示；与 `SftpTreeProvider.test.ts` 核对兼容性）。
  3. 增量补齐常用 SFTP 命令：`jumpserverManager.sftp.goToPath`（视图标题栏跳转路径）、`jumpserverManager.sftp.newFile`（目录右键新建文件）、`jumpserverManager.sftp.cdToDirectory`（向当前关联终端写入 `cd <quotedPath>`）。
- [x] **涉及文件**：`package.json`、`package.nls*.json`、`l10n/bundle.l10n*.json`、`src/tree/SftpTreeProvider.ts`、`src/tree/SftpTreeItems.ts`、`src/extension.ts`、`test/tree/SftpTreeProvider.test.ts`、`test/package.manifest.test.ts`。
- [x] **验收标准**：点击 SFTP `pending` 占位行可直连远端目录；新增文件树操作单测与清单校验全部通过。

### Task 2.3：资产树图标体系、多账号选择与 `@INPUT` 提示国际化
- [x] **现状与根因**：
  - `src/tree/TreeItems.ts`（第 20-36 行）与 `src/tree/BastionTreeItem.ts`（第 5-13 行）未设置 `iconPath`，SSH、MySQL、Redis、不支持资产及堡垒机/分组在视觉上缺少图标区分。
  - `src/jumpserver/JumpServerClient.ts`（第 443-490 行）的 `resolveFirstUsableAccount` 固定选取第一个可用账号，若同一个资产同时授权了 `root`、`ubuntu`、只读账号等，用户无法自由切换登录账号。
  - `src/webview/TerminalPanel.ts`（第 339-353 行）的 `@INPUT` 临时输入账号密码弹窗文案为硬编码英文，未接入 `t(...)`。
- [x] **改造方案**：
  1. **图标体系**：为 `BastionTreeItem` 设置 `new vscode.ThemeIcon('server-environment')`（或 `cloud`），`GroupTreeItem` 设置 `new vscode.ThemeIcon('folder')`，`AssetTreeItem` 按 `openKind` 设置 `$(terminal)`（SSH）、`$(database)`（MySQL/Redis）、`$(circle-slash)`（Unsupported）。**注意**：同步更新 `test/tree/JumpServerTreeProvider.test.ts` 第 160、195 行的 `expect(asset.iconPath).toBeUndefined()` 断言。
  2. **多账号选择**：在 `JumpServerClient.ts` 抽取出 `resolveUsableAccounts(detail)` 返回全部可用账号列表；在连接入口或右键菜单提供「选择账号连接」或当存在 `>= 2` 个可用账号时弹出 QuickPick（并支持按 `bastionId/assetId` 在 `globalState` 中记忆上次所选账号，提供一键直连默认体验）。注意兼容 `JumpServerSession` 已有的 `resolveFirstUsableAccount` 单测。
  3. **`@INPUT` 国际化**：将 `TerminalPanel.ts` 第 341、348 行的提示文案接入 `t(...)` 并更新 `l10n` 翻译。
- [x] **涉及文件**：`src/tree/TreeItems.ts`、`src/tree/BastionTreeItem.ts`、`src/jumpserver/JumpServerClient.ts`、`src/jumpserver/JumpServerSession.ts`、`src/webview/TerminalPanel.ts`、`l10n/bundle.l10n.zh-cn.json`、`test/tree/JumpServerTreeProvider.test.ts`、`test/jumpserver/JumpServerClient.test.ts`、`test/jumpserver/JumpServerSession.test.ts`。
- [x] **验收标准**：资产树直观区分节点与协议类型；多账号资产支持选号连接；`@INPUT` 弹窗支持中文展示。

### Task 2.4：优化堡垒机配置面板体验
- [x] **现状与根因**：
  - `src/webview/JumpServerConfigPanel.ts`（第 122-138 行）与 `webview/jumpserver-config/index.ts`、`index.css` 表单过于极简：编辑模式密码框留空可保留原密码，但界面没有任何提示；无“测试连接”功能，报错时仅靠外部错误弹窗反馈；按钮缺乏悬停/禁用态。
- [x] **改造方案**：
  1. 在编辑模式为密码框补充 placeholder（如 `t('Leave blank to keep current password')`），为 `baseUrl` / `orgId` 补充示例与说明文字。
  2. 新增 `type: 'test'` 消息与“测试连接”按钮，在不落盘、不关闭面板的前提下创建临时 `JumpServerClient` 执行 `healthCheck() + ensureAuthToken() + getUserProfile()`（若未填 `orgId` 顺带探测可访问组织列表），并将结果内联显示在表单下方状态条中。
  3. 美化 `webview/jumpserver-config/index.css`：增加输入框 focus 轮廓、按钮 `cursor: pointer`、`:hover`、`:disabled`（请求中防连击）、成功/错误提示条样式。
- [x] **涉及文件**：`src/webview/JumpServerConfigPanel.ts`、`webview/jumpserver-config/index.ts`、`webview/jumpserver-config/index.css`、`l10n/bundle.l10n.zh-cn.json`、`test/webview/JumpServerConfigPanel.test.ts`。
- [x] **验收标准**：`JumpServerConfigPanel.test.ts` 覆盖测试连接消息、表单提示与保存路径。

---

## 4. Phase 3：性能优化（P2）

### Task 3.1：资产树节点索引缓存（大资产库展开性能优化）
- [ ] **现状与根因**：
  - `src/tree/JumpServerTreeProvider.ts`（第 43-50、92-133 行）在每次展开任意分组节点时，都会重新异步读取全部 `nodes`、`assets`、`trustOverlay`，按 `bastionId` 全量过滤并在 `normalizedNodePaths` 中重建整棵树路径表。当堡垒机资产达到数千至上限 `10_000` 条时，展开子目录存在重复计算开销。
- [ ] **改造方案**：
  1. 在 `JumpServerTreeProvider` 内增加按 `bastionId` 维度缓存的索引结构（`Map<string, BastionTreeIndex>`），预构建 `childNodePathsByParentKey` 与 `assetsByPathKey`，展开节点时做到 $O(1)$ 取子节点、仅按需构造展示项。
  2. 在 `refresh()` 被调用时清空索引缓存；保持对外 `JumpServerAssetSource` 接口不变，确保所有现有 tree tests 零破坏迁移。
- [ ] **涉及文件**：`src/tree/JumpServerTreeProvider.ts`、`test/tree/JumpServerTreeProvider.test.ts`。
- [ ] **验收标准**：`JumpServerTreeProvider.test.ts` 全绿，新增断言验证同一次树未刷新前多次展开子分组不会重复触发底层 `listCachedAssets()` 全量拉取。

### Task 3.2：SFTP 大文件分块流式上传
- [ ] **现状与根因**：
  - 下载已通过 `JumpServerSftpSession.downloadFileToWriter` + `createWriteStream` 实现流式落盘（`src/sftp/JumpServerSftpManager.ts` 第 200-216 行），不整文件占用堆内存。
  - 但上传在 `src/sftp/JumpServerSftpManager.ts`（第 189-197 行）仍先执行 `const bytes = await readFile(localPath)` 将整个文件一次读入单个 `Buffer`，然后才交给 `uploadBytes` 按 4 MiB（`SFTP_UPLOAD_CHUNK_BYTES`）切片发送。上传数百 MB 文件时仍会短暂峰值占用同等内存。
- [ ] **改造方案**：
  1. 为 `JumpServerSftpSession` 与 `JumpServerSftpSessionLike` 增加可选方法 `uploadFromFile?(remotePath: string, localPath: string, onProgress?: SftpUploadProgress): Promise<void>`（或接收分块 `readChunk` 回调）。
  2. 内部使用 `node:fs/promises` 的 `open(localPath, 'r')` + 固定 `4 MiB` 复用缓冲区循环 `fh.read(...)` 并发送 `chunk: true` 帧，最后发送 `merge: true`（≤ `SFTP_UPLOAD_CHUNK_BYTES` 的小文件走单帧 `chunk: false` 保持单次往返）；在 `finally` 中确保关闭文件句柄 `fh.close()`。
  3. `JumpServerSftpManager.uploadFile` 优先调用 `session.uploadFromFile`，对未实现该方法的测试替身保持回退到 `readFile + uploadBytes`。
- [ ] **涉及文件**：`src/sftp/JumpServerSftpSession.ts`、`src/sftp/JumpServerSftpManager.ts`、`test/sftp/JumpServerSftpSession.test.ts`、`test/sftp/JumpServerSftpManager.test.ts`。
- [ ] **验收标准**：新增大文件（跨多片，如 > `SFTP_UPLOAD_CHUNK_BYTES`）分块读取上传单测，验证首尾分片、进度回调、句柄关闭及失败中断语义。

---

## 5. Phase 4：架构演进与工程卫生（P2 / P3）

### Task 4.1：清理 l10n 生产包测试脏数据并加固测试守卫
- [ ] **现状与根因**：
  - `l10n/bundle.l10n.zh-cn.json`（第 4-10 行）混入了仅用于 `test/i18n/t.test.ts` 的测试字符串与 XSS 测试样本：
    - `"{path} -> {path}"`
    - `"{count} items, verifyTls: {verifyTls}"`
    - `"JumpServer at {url} ({version})"`
    - `"Configure: {label}"`
    - `"</script><img src=x onerror=alert(1)>"`
    以及部分已不再调用的历史翻译条目（例如 `"JumpServer assets refreshed: {count}"` 等）。
- [ ] **改造方案**：
  1. 梳理并清理 `l10n/bundle.l10n.zh-cn.json` 中所有源码 `src/` 与 `webview/` 未使用的冗余/测试 key，执行 `npm run sync:l10n` 自动刷新 `zh-hans` 与 `zh` 文件。
  2. 注意核对 `test/i18n/t.test.ts`（该测试使用 mock 透传逻辑，不依赖磁盘上的 `bundle.l10n.*.json`）及 `test/i18n/nls.test.ts`。
  3. 在 `test/i18n/nls.test.ts` 中增加「无冗余未使用 key」或「禁止危险测试 payload 进入生产 l10n 包」的断言（类似该文件第 190-194 行对 `package.nls.json` 的反向检查）。
- [ ] **涉及文件**：`l10n/bundle.l10n.zh-cn.json`、`l10n/bundle.l10n.zh-hans.json`、`l10n/bundle.l10n.zh.json`、`test/i18n/nls.test.ts`。
- [ ] **验收标准**：`npm run sync:l10n && npm test` 全绿；`bundle.l10n.*.json` 不含测试脏数据。

### Task 4.2：构建脚本去重与历史残留文件清理
- [ ] **现状与根因**：
  - `package.json`（第 292 行）的 `"build"` 脚本在 `node esbuild.config.mjs` 之后又执行了一次 `npm run copy:policy-assets`；但 `esbuild.config.mjs`（第 120-121 行）在非 watch 模式下已经执行了 `await copyPolicyRuntimeAssets()`，属于重复拷贝。
  - 工程根目录留存了 11 个历史 `.vsix` 安装包（`0.1.3` ~ `0.2.0`），以及本地临时目录 `.tmp-jumpserver-bridge-discovery-remove`、`.tmp-jumpserver-mcp-installer`、`.worktrees/jumpserver-redis-terminal`。
- [ ] **改造方案**：
  1. 统一 `policy-assets` 复制归口：从 `package.json` 的 `build` 脚本移除多余的 `&& npm run copy:policy-assets`（或由 `package.json` 显式串行而移除 `esbuild.config.mjs` 非 watch 重复调用，推荐保留 `esbuild.config.mjs` 内聚处理并精简 `package.json` 脚本）。
  2. 核实 `.worktrees/jumpserver-redis-terminal` 与 `.tmp-*` 分支/改动已合并进 `main` 后，通过 `git worktree remove` 与手动清理移除本地陈旧工作树、临时目录和过时的历史 `.vsix` 包。
- [ ] **涉及文件**：`package.json`（或 `esbuild.config.mjs`）、本地未追踪临时产物。
- [ ] **验收标准**：`npm run build` 无重复步骤且 `dist/` 产物与之前一致（`test/package.policyBundle.test.ts` 通过）。

### Task 4.3：巨石文件渐进式拆分
- [ ] **现状与根因**：
  - `src/jumpserver/JumpServerClient.ts` 达 2255 行，混杂 Cookie 解析与持久化、分页与资产/树节点归一化、Connection Token payload 拼装、KoKo Endpoint/Ticket/WebSocket 握手及 REST 重试逻辑。
  - `src/extension.ts` 达 954 行，所有命令注册、选堡垒机/组织上下文逻辑、SFTP 操作辅助集中在一个入口文件。
- [ ] **改造方案**：
  1. **拆分 `src/jumpserver/`**：
     - `src/jumpserver/cookieJar.ts`（`parseSetCookieHeader`、`cookiesForUrl`、`parseStoredWebSession` 等）
     - `src/jumpserver/assetNormalizer.ts`（`normalizeJumpServerAsset`、`extractNodePath`、`extractAssetTreeNodes`、`resolveFirstUsableAccount` 等）
     - `src/jumpserver/tokenPayload.ts`（`buildConnectionTokenPayload`、`buildSftpConnectionTokenPayload`、`buildMysqlConnectionTokenPayload`、`buildRedisConnectionTokenPayload` 等）
     - `src/jumpserver/kokoEndpoints.ts`（`buildKokoConnectUrl`、`buildKokoWsUrl`、`buildKokoSftpWsUrl`、`kokoWsAgentForEndpoint` 等）
     - **平滑迁移技巧**：在 `JumpServerClient.ts` 保留上述纯函数的 `export { ... } from './...'` 重导出，保证所有现有单元测试与调用方的 import 路径零修改。
  2. **拆分 `src/extension.ts`**：
     - `src/commands/bastionCommands.ts`（configure / addBastion / editBastion / removeBastion / refreshBastion / validate / refresh）
     - `src/commands/assetCommands.ts`（connect / copyHostIp / setAssetTrust / disconnect / reconnect）
     - `src/commands/sftpCommands.ts`（全部 `sftp.*` 命令及保护/目标目录解析 helper）
     - `src/commands/mcpCommands.ts`（`installMcpConfig` / `uninstallAtSeriesMcpConfig`）
- [ ] **涉及文件**：`src/jumpserver/*`、`src/extension.ts`、`src/commands/*`。
- [ ] **验收标准**：`npm run typecheck && npm test && npm run build` 零报错、全测试集无需大幅改路径即可全部通过。

---

## 6. 全量发布前验收清单（Release Verification Checklist）

完成上述所有期望 Phase 后，按顺序执行完整发布门禁：

- [ ] `npm run sync:l10n`（确认多语言文件严格一致）
- [ ] `npm run typecheck`（确认 TypeScript 严格检查通过）
- [ ] `npm test`（确认全部 Vitest 单元测试 & 集成守卫通过）
- [ ] `npm run build`（确认生成干净的 `dist/` 各独立 bundle）
- [ ] `npm run package`（生成新的 `.vsix` 安装包）
- [ ] **真机 / 真实 JumpServer 冒烟验证（v3 / v4 / v5 至少各覆盖一套）**：
  - [ ] 资产树与堡垒机悬停不再出现遮挡 IP/域名的长文字按钮，协议与状态图标清晰可辨
  - [ ] 中文与英文语言包下：终端连接中（黄灯）→ 已连接（绿灯）→ 主动/超时断连（红灯）颜色与文案完全一致，点击重连按钮可恢复会话
  - [ ] 首屏打开终端即按当前窗格实际行列数初始化（非 `80x24` 错位）
  - [ ] SFTP 保持首次点击/刷新才建连的懒加载行为；断线后再次操作文件树可自动重连恢复
  - [ ] 配置面板测试连接、修改 `kokoBearerHandshake`、切换多账号与编辑保存同步均符合预期
