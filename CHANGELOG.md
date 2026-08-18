# 更新日志 (Changelog)

所有关键版本的更新记录都将在此文档中记录。

---

## [v0.1.8] - 2026-08-18

**VS Code 官方标准国际化 (l10n) 与中英文双语支持发布！🌐**

本版本主要为 AT JumpServer Terminal 扩展引入了完整的 **VS Code 官方多语言架构 (l10n)**，支持中英文双语无缝自适应切换，覆盖扩展清单、资产树、SFTP 会话传输、配置面板与终端状态提示。

### 🌟 核心特性与功能亮点

#### 1. 官方标准国际化架构 (`vscode.l10n` & `t()`)
- **VS Code 原生多语言支持**：引入 `vscode.l10n` 官方机制与轻量 `t()` 包装函数，内置缺失回退与动态参数插值能力。
- **扩展清单本地化 (NLS)**：全面重构 `package.json`，命令标题、视图名称、配置描述与右键菜单全量接入 `%atJumpServer...%` 占位符，提供 `package.nls.json` 与 `package.nls.zh-cn.json`。
- **运行时语言包**：新增 `l10n/bundle.l10n.zh-cn.json` 运行时语言包，中英文环境无缝切换，无需重启扩展。

#### 2. JumpServer 资产、终端与 SFTP 流程全面本地化
- **资产树与操作交互**：资产节点工具提示、复制 IP、终端连接提示、断开重连及不支持协议警告全量支持多语言。
- **SFTP 文件生命周期**：文件上传、下载、预览、远程编辑同步、目录新建、删除与重命名对话框全面接入本地化。
- **安全拦截与守护提示**：大文件流式传输保护、二进制文件编辑拦截与警告弹窗中英文自适应。
- **配置与终端面板**：JumpServer 实例配置表单（`JumpServerConfigPanel`）与终端状态面板（`TerminalPanel`）文案及校验错误本地化。

#### 3. 质量与测试工程化
- **新增国际化单元测试**：引入 `test/i18n/nls.test.ts` 与 `test/i18n/t.test.ts`，验证 NLS 字典完整性与运行时翻译回退，全套 424 个测试用例全部通过。

---

## [v0.1.7] - 2026-08-17

**JumpServer Redis 终端支持与 Redis MCP 命令执行正式发布！🎉**

本版本主要为 AT JumpServer Terminal 扩展引入了完整的 **Redis 资产终端会话** 与 **AI Agent Redis MCP 工具调用** 支持，并重构了终端统一上下文协议，全面增强了 Redis 操作的安全防护机制。

### 🌟 核心特性与功能亮点

#### 1. Redis 资产识别与终端直连 (Redis Terminal Connection)
- **协议与资产自动识别**：扩展 JumpServer 资产分类体系，支持识别 `redis`、`redis_cluster` 等协议资产。
- **动态连接 Token 生成**：对接 JumpServer `db_client` 协议接口，安全获取 Redis 终端连接凭据。
- **UI 资产树直连入口**：在 VS Code 侧边栏 JumpServer 资产树中展示 Redis 资产节点，支持点击直接拉起 Redis CLI 终端会话。
- **终端交互优化**：基于 xterm.js 提供原生 Redis 命令行交互体验，自动处理提示符回显与终端重绘。

#### 2. Redis MCP 命令执行工具 (`jumpserver_redis_execute_command`)
- **MCP 工具全新发布**：注册并暴露 `jumpserver_redis_execute_command`，赋能 AI Agent 直接在 JumpServer Redis 终端中执行指令。
- **`ECHO` 标记精准捕获**：引入 `RedisCliExecutor`，利用注入 `ECHO` marker 输出分界机制，精确提取目标命令输出，彻底消除提示符、ANSI 颜色代码及终端回绘噪点。
- **回车换行 (`\r`) 兼容**：底层适配 `redis-cli` 交互缓冲特性，保证 marker 命令稳定触发与执行。
- **单行与非阻塞保护**：严格限制单次调用仅支持单条 Redis 指令，主动拦截多行 payload；对阻塞式命令（如 `SUBSCRIBE`、`MONITOR`、`BLPOP` 等）进行阻断并指引使用交互式终端。

#### 3. Redis 安全拦截与二次确认体系 (`RedisSafety`)
- **高危命令黑名单拦截**：启发式检测并严格阻断 `FLUSHALL`、`FLUSHDB`、`SHUTDOWN`、`CONFIG`、`DEBUG`、`SAVE`、`BGSAVE`、`BGREWRITEAOF`、`SLAVEOF`、`REPLICAOF` 等高危破坏性指令。
- **写操作状态确认**：针对 `SET`、`DEL`、`HSET`、`LPUSH` 等修改类指令，强制接入 `formatCommandConfirmMessage` 弹窗确认，明确提示目标主机与执行命令，用户确认后方可执行；只读命令（`GET`、`HGET`、`SCAN`、`PING`、`INFO` 等）安全快速放行。

#### 4. MCP 工具链统一与架构重构 (Unified Terminal MCP Toolchain)
- **终端上下文与输入工具统一**：废弃原分散的 MySQL 专用工具，统一采用通用的 `jumpserver_get_terminal_context` 与 `jumpserver_send_terminal_input`，支持通过 `connectionKind` (`ssh` / `mysql` / `redis`) 灵活检索与定向操作各协议终端。
- **技能规范更新**：更新 `skills/at-jumpserver-terminal-mcp/SKILL.md`，增加 Redis 最佳实践指导（推荐 `SCAN` 替代 `KEYS *`、限制输出为 64KB/256KB）。
- **MCP Hub 0.3.0 深度集成**：完整继承 `@at-series/mcp-hub@^0.3.0` 安全基准（禁用跨域重定向、2MB 响应流式截断、常数时间 Token 校验）。

---

## [v0.1.6] - 2026-08-14

- **MCP Hub 升级**：依赖切为公共 npm 包 `@at-series/mcp-hub@^0.3.0`，适配最新集中式 Hub 协议。
- **空闲超时断开**：支持 `jumpserverManager.idleDisconnectMinutes` 配置，超时无操作自动断开终端以释放 JumpServer 连接配额。
- **UI 响应优化**：Toast 弹窗改为非阻塞异步，解决长耗时操作下调用方卡死的问题。
- **KoKo Socket 容错**：增强 KoKo WebSocket 死亡检测，限制发送队列长度，防止网络异常导致内存泄露。
- **日志脱敏与生命周期**：新增 Output Channel 日志通道，统一两阶段凭据脱敏，修复 subscriptions 泄露。
- **资产分页与搜索**：`jumpserver_list_assets` 支持 `search`、`limit`、`offset` 分页，解决大规模资产列表截断问题。

---

## [v0.1.5] - 2026-05-28

- **SFTP 文件管理**：支持 JumpServer 远程文件树浏览、文件预览、内存草稿编辑与自动回写保存、上传、下载、删除、重命名与新建目录。
- **主机 IP 一键复制**：在资产节点增加 `Copy Host IP` 快捷菜单。
- **AT Series MCP Hub 拆分**：将多插件分散的 MCP Server 架构收敛为单一的 AT Series Hub 统一接入点。

---

## [v0.1.4] - 2026-05-27

- **MySQL 终端支持**：支持识别 JumpServer MySQL 数据库资产并建立终端连接。
- **SQL 执行 MCP 工具**：引入 `jumpserver_mysql_execute_sql` 工具，支持安全的只读/写 SQL 区分与拦截确认。

---

## [v0.1.0] ~ [v0.1.3] - 2026-05-13

- **首发版本发布**：JumpServer 账号认证、资产树（节点/组织/区域分组）、SSH 终端 Webview 连接（基于 xterm.js 与 WebSocket 双向流式通信）、VS Code `SecretStorage` 密码加密存储。
