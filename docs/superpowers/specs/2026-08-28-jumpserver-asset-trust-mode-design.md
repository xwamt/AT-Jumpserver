# 资产三层命令信任模式 Design

**Date:** 2026-08-28
**Status:** Draft — implementation plan: `docs/superpowers/plans/2026-08-28-jumpserver-asset-trust-mode.md`
**Sibling spec:** `docs/superpowers/specs/2026-08-28-jumpserver-command-policy-integration-design.md`（`@at-series/command-policy` 的加载、`authorizeAssetCommand` trust×decision 授权层、三条命令工具的接线；本设计提供它消费的 trust 值与全部 trust UI / 存储）
**Sibling plan:** `docs/superpowers/plans/2026-08-28-jumpserver-command-policy-integration.md`
**参照实现:** At-Terminal `src/agent/agentCommandTrust.ts` / `src/agent/remoteCommandAuthorization.ts` / `src/agent/SftpWriteAuthorizer.ts`（`none` | `policy` | `full` 三档）

---

## 1. Goal

针对**每个 JumpServer 资产**提供与 At-Terminal 服务器相同的三层命令信任模式：

- **不信任（`none`，默认）**：所有代理命令（SSH / MySQL / Redis 执行工具）都弹窗确认。
- **有限信任（`policy`）**：命令交给 `@at-series/command-policy` 审查（shell / mysql / redis 三个域，见姊妹设计 D4–D9），只有 `allow` 免确认。
- **完全信任（`full`）**：三个执行工具与 SFTP 写入都不弹窗；`jumpserver_send_terminal_input` 例外，任何信任档都弹窗。

信任级别在资产树右键设置，本地持久化，刷新资产 / 重连后仍然生效，且修改后**下一次 MCP 调用立即按新档执行**。

### 与姊妹设计的所有权划分

| 关切 | 归属 |
|---|---|
| trust 的存储 schema、overlay 持久化、`resolveAssetTrust` 实现、树 UI、`setAssetTrust` 命令、l10n | **本设计** |
| SFTP 写族确认 × trust 映射 | **本设计**（姊妹设计 D6 明确移交） |
| `send_terminal_input` / SFTP 写族的 catalog 描述 | **本设计** |
| `authorizeAssetCommand`（`src/agent/assetCommandTrust.ts`）、policy-runtime bundle、懒加载器、三条命令工具接线、`SqlSafety` / `RedisSafety.isReadOnlyRedisCommand` **降权为确认文案选择器**（不再决定免确认） | 姊妹设计（本设计不重复实现） |
| 三条命令工具的 catalog trust 描述 | 姊妹设计（Task 8） |

两份设计共享同一份产品决策：trust 挂资产、默认 `none`、`send_terminal_input` 永远确认。接缝是姊妹设计 D2 定义的注入点：

```ts
// JumpServerAgentToolServiceDependencies（姊妹设计 Task 7 引入，缺省恒 'none'）
resolveAssetTrust?: (asset: CachedJumpServerAsset) => 'none' | 'policy' | 'full';
```

本设计负责在 `extension.ts` 把它接到真实存储上。两个计划可任意先后落地：先落本设计则命令工具尚未消费 trust（SSH 保持每次确认、MySQL/Redis 保持只读免确认，`full` 暂只对 SFTP 生效）；先落姊妹计划则一切按缺省 `none`（更严、安全）。建议同一 release 合入（姊妹计划 rollout note）。

## 2. 决策（locked）

| # | 决策 |
|---|------|
| D1 | 三档取值与 At-Terminal 完全一致：`'none' \| 'policy' \| 'full'`；类型名 `AssetCommandTrust`，规范定义在 `src/config/schema.ts`。姊妹计划在 `src/agent/assetCommandTrust.ts` 可暂用同名同构 union（为了两计划解耦落地）——string union 结构兼容，无运行时冲突；两者都合入后用一行 `import type` 收敛到 schema，不阻塞任何一方。 |
| D2 | 信任按**资产**设置，不按堡垒机。身份键是 `bastionId` + `assetId`（asset id 跨堡垒机不保证唯一）。 |
| D3 | 每个资产默认 `none`。overlay 中缺失、解析失败、值非法 → 一律按 `none`（不信任）。 |
| D4 | 持久化在 extension `globalState` 的独立 overlay map（key `jumpserverManager.assetTrust`），**不写在** `jumpserverManager.cachedAssets` 的资产记录上——那份缓存每次 Refresh 都被整体覆盖。也**不写** VS Code `settings.json`（与堡垒机配置一样走扩展存储，避免 Settings Sync 泄露安全策略）。 |
| D5 | overlay 只存非默认档（`policy` / `full`）；设回 `none` 即删除该条目。刷新资产、重连不清 overlay；只有 `deleteBastion`（清该堡垒机前缀的条目）和 `deleteSettings`（清整个 key）会删。 |
| D6 | 授权在**每次工具调用时**读 overlay（`resolveAssetTrust` at authorize time），不在连接时快照。改信任对已连接终端的下一次 MCP 调用立即生效。因此 `resolveAssetTrust` 是**同步**函数（姊妹设计的签名如此）：直读 `globalState`（VS Code `Memento.get` 本身同步）+ 写后失效的 memoize。 |
| D7 | `none` 下 MySQL / Redis 的**只读语句也弹窗**；`policy` 下三个域都由 `@at-series/command-policy` 判定（shell / mysql / redis evaluator，姊妹设计 D8/D9）。`isReadOnlySql` / `isReadOnlyRedisCommand` **降权为确认文案措辞选择器**，不再决定免确认；`isBlockingRedisCommand` 保留为硬拒绝。这是现状（只读免确认）的刻意收紧，随姊妹计划 Phase B 生效并写入 release note。 |
| D8 | `jumpserver_send_terminal_input` 在任何信任档下都弹窗（姊妹设计 D6 同一条款：原始终端输入不评估、永远确认）。 |
| D9 | SFTP 写入（write / create file / create directory / rename）镜像 At-Terminal `shouldAutoApproveSftpWrite`：只有 `full` 免确认；`none` / `policy` 仍然逐次确认（策略包不分析 SFTP 路径）。**`sftp_delete` 任何信任档都弹窗**（对齐 At-Terminal `requireDelete`：完全信任也不跳过删除）。JumpServer 不引入 At-Terminal 的目录授权（grant TTL / 敏感路径二次确认）——现状是逐次确认，保持不变。SFTP 连接解析不出资产（`getConnectionAsset` 返回 undefined）按 `none` 处理。 |
| D10 | UI：资产右键菜单一条命令 `jumpserverManager.setAssetTrust` + 三项 QuickPick；非默认档在资产 `description` 追加后缀并写入 tooltip。**不改 iconPath**（部分条目有图标会破坏整树对齐）。 |
| D11 | 结构性拒绝不受信任档影响：空命令、多行 Redis 命令、blocking Redis 命令（姊妹设计 D8 保留 `isBlockingRedisCommand` 且先于 trust 判定）、非匹配终端类型，在 `full` 下照样抛错。 |
| D12 | 不引入 At-Terminal 的「后台连接」（`backgroundConnectionAllowed`）——JumpServer 没有后台连接机制，MCP 工具要求已连接终端，不发明新机制。 |
| D13 | 没有 legacy 布尔字段要兼容（At-Terminal 的 `agentCommandAutoApprove` 在 JumpServer 无对应物），`parseAssetCommandTrust` 对未知值直接回 `none`。 |

## 3. 行为矩阵（两设计合并后的最终状态）

| 工具 | `none`（默认） | `policy` | `full` |
|---|---|---|---|
| `jumpserver_run_terminal_command` | 弹窗 | command-policy shell 评估：`allow` → 直接执行；`review` / `deny` / 加载失败 → 弹窗（附 evidence 摘要与 policyNote，格式归姊妹设计） | 直接执行 |
| `jumpserver_mysql_execute_sql` | 弹窗（含只读 SELECT） | command-policy mysql 评估，同上 | 直接执行 |
| `jumpserver_redis_execute_command` | 弹窗（含只读命令） | command-policy redis 评估，同上（blocking 命令先行硬拒绝） | 直接执行 |
| `jumpserver_send_terminal_input` | 弹窗 | 弹窗 | **弹窗** |
| `jumpserver_sftp_write_file` / `create_file` / `create_directory` / `rename` | 弹窗 | 弹窗 | 直接执行 |
| `jumpserver_sftp_delete` | 弹窗 | 弹窗 | **弹窗**（对齐 At-Terminal：删除永不免确认） |
| 只读工具（`list_assets` / `get_terminal_context` / `sftp_list_directory` / `sftp_stat_path` / `sftp_read_file`） | 不弹窗（现状） | 同左 | 同左 |

命令列的行为由姊妹设计实现；SFTP 行与 `send_terminal_input` 行由本设计实现。`full` 档下即使 `isObviouslyDestructive` 命中（`rm -rf` 等）也不弹窗——与 At-Terminal `authorizeRemoteCommand` 相同（`full` 直接 `autoApprove: true`）。

## 4. 数据模型与持久化

### 4.1 类型（`src/config/schema.ts`）

```ts
export const ASSET_COMMAND_TRUST_LEVELS = ['none', 'policy', 'full'] as const;
export type AssetCommandTrust = (typeof ASSET_COMMAND_TRUST_LEVELS)[number];

export function parseAssetCommandTrust(value: unknown): AssetCommandTrust {
  return ASSET_COMMAND_TRUST_LEVELS.includes(value as AssetCommandTrust)
    ? (value as AssetCommandTrust)
    : 'none';
}

/** overlay 的复合键。bastionId / assetId 都是 UUID，不含 '/'。 */
export function assetTrustKey(bastionId: string, assetId: string): string {
  return `${bastionId}/${assetId}`;
}

/**
 * 防御式解析整个 overlay：值不是 'policy' | 'full' 的条目直接丢弃
 * （'none' 不落盘；损坏条目回默认不信任，与 parseCachedRows 的丢行策略一致）。
 */
export function parseAssetTrustOverlay(value: unknown): Record<string, 'policy' | 'full'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, 'policy' | 'full'> = {};
  for (const [key, trust] of Object.entries(value)) {
    if (trust === 'policy' || trust === 'full') {
      result[key] = trust;
    }
  }
  return result;
}
```

### 4.2 持久化键

| Key | Store | Value |
|---|---|---|
| `jumpserverManager.assetTrust` | globalState | `Record<string, 'policy' \| 'full'>`，键为 `${bastionId}/${assetId}` |

不含密码等敏感值，走 globalState 而非 secrets；但属于安全策略，遵循堡垒机配置的存储模式，不进 `settings.json`。

### 4.3 生命周期

- **Refresh 资产 / 重连**：不触碰 overlay。`saveCachedAssets` 整体重写资产缓存，但 overlay 独立存储，所以信任天然幸存。缓存中暂时消失的资产的 overlay 条目**保留**（资产 id 稳定，下次刷新回来继续生效；连不上的资产条目无害）。
- **`deleteBastion(id)`**：删除所有 `${id}/` 前缀的条目（与该方法现有的资产 / 节点清理并列）。
- **`deleteSettings()`**：`globalState.update(ASSET_TRUST_KEY, undefined)`，与其他键的清理并列。
- 不做旧数据迁移——这是全新的 key，且与 legacy 单堡垒机迁移无关。

## 5. 配置管理 API（`src/config/JumpServerConfigManager.ts`）

```ts
const ASSET_TRUST_KEY = 'jumpserverManager.assetTrust';

// class 内新增（沿用 bastionsCache 的 memoize + 写后失效模式）：
private assetTrustCache?: Record<string, 'policy' | 'full'>;

/**
 * 同步读，授权门每次调用都走它（D6）。VS Code Memento.get 是同步 API；
 * 该 key 不参与 legacy 迁移，无需 migrateIfNeeded。缺失 / 损坏 → 'none'。
 */
resolveAssetTrust(bastionId: string, assetId: string): AssetCommandTrust;

/** 'none' 删除条目；'policy' / 'full' 写入。读-改-写整张 map，写后使缓存失效。 */
async setAssetTrust(bastionId: string, assetId: string, trust: AssetCommandTrust): Promise<void>;

/** 树装饰用：一次拿全部（或按堡垒机过滤的）非默认覆盖。 */
async listAssetTrustOverrides(bastionId?: string): Promise<Record<string, 'policy' | 'full'>>;
```

实现要点：

- 读路径共用 `this.assetTrustCache ??= parseAssetTrustOverlay(this.globalState.get<unknown>(ASSET_TRUST_KEY, {}))`；`setAssetTrust` 更新后 `this.assetTrustCache = undefined`，同窗口下一次 `resolveAssetTrust` 即读到新值。
- `resolveAssetTrust` = `overlay[assetTrustKey(bastionId, assetId)] ?? 'none'`。
- `listAssetTrustOverrides(bastionId)` 按键前缀 `${bastionId}/` 过滤，返回浅拷贝。
- `deleteBastion` / `deleteSettings` 增加第 4.3 节的清理并使缓存失效。

## 6. 授权接线

### 6.1 命令工具（归姊妹设计，此处只描述接缝）

姊妹设计 Task 7 在 `JumpServerAgentToolService` 上引入：

```ts
resolveAssetTrust?: (asset: CachedJumpServerAsset) => AssetCommandTrust;   // 缺省恒 'none'

private trustOf(asset: CachedJumpServerAsset): AssetCommandTrust {
  return this.dependencies.resolveAssetTrust?.(asset) ?? 'none';
}
```

三条命令工具经其 `authorizeAssetCommand`（`src/agent/assetCommandTrust.ts`）分流。本设计**不**改这三条工具，只在 `extension.ts` 提供真实的 resolver：

```ts
// extension.ts 构造 JumpServerAgentToolService 时：
resolveAssetTrust: (asset) => configManager.resolveAssetTrust(asset.bastionId, asset.id),
```

若本计划先落地而姊妹计划未落地，`resolveAssetTrust` 依赖字段与 `trustOf` helper 由本计划按上述完全一致的签名先行创建（后落地者直接复用，无合并分歧）。

时序保证（已连接资产改信任 → 立即生效）：`TerminalContext` 缓存的是资产快照，但 resolver 只从快照取 `bastionId` / `id` 两个稳定标识，级别本身每次调用重新查 overlay；`setAssetTrust` 写入后缓存失效，同窗口的下一次 MCP 调用即读到新值。

### 6.2 SFTP 写族（本设计实现）

`JumpServerAgentToolService` 新增私有 gate，四个 SFTP 写工具（`sftpWriteFile` / `sftpCreateFile` / `sftpCreateDirectory` / `sftpRename`）把开头的 `await this.requireConfirm(message)` 换成 `requireSftpWriteConfirm`。**`sftpDelete` 继续走 `requireConfirm`，任何 trust 都不跳过（D9）。**

```ts
private async requireSftpWriteConfirm(
  input: { connectionKey?: string; terminalId?: string },
  message: string
): Promise<void> {
  const asset = this.dependencies.sftp.getConnectionAsset(connectionKeyOf(input));
  const trust = asset ? this.trustOf(asset) : 'none';   // 解析不出资产 → 不信任（D9）
  if (trust === 'full') {
    return;                                             // 镜像 At-Terminal shouldAutoApproveSftpWrite
  }
  await this.requireConfirm(message);
}
```

不新建授权模块：gate 是一个表达式，行为由 service 级测试锚定（At-Terminal 的 `shouldAutoApproveSftpWrite` 语义 = `trust === 'full'`，此处内联）。`policy` 不给 SFTP 任何豁免（D9）。`sftpDelete` 与 `sendTerminalInput` 零改动（永远确认）。

## 7. UI：资产树 + 设置命令

### 7.1 树装饰（`src/tree/TreeItems.ts` + `src/tree/JumpServerTreeProvider.ts`）

- `JumpServerAssetSource` 增加可选方法：

```ts
listAssetTrustOverrides?(): Promise<Record<string, 'policy' | 'full'>>;
```

- `getChildren` 在会产出 `AssetTreeItem` 的分支里取一次 overlay（缺省 `{}`），把 `overlay[assetTrustKey(asset.bastionId, asset.id)] ?? 'none'` 传给构造函数。
- `AssetTreeItem` 构造函数追加可选参数 `trust: AssetCommandTrust = 'none'`：
  - `description`：非默认档追加 ` · ${t('Limited trust')}` / ` · ${t('Full trust')}`（`none` 保持现状，树不加噪音）。
  - `tooltip`：追加一行 `${t('Agent command trust')}: ${levelLabel}`（三档都显示，含 `none` = `t('Untrusted')`）。
  - `contextValue` / `id` / `command` 不变（菜单 `when` 继续用现有 viewItem 值）。
  - 不设 `iconPath`（D10）。
- `extension.ts` 的树 source 传入 `listAssetTrustOverrides: () => configManager.listAssetTrustOverrides()`。

### 7.2 命令 `jumpserverManager.setAssetTrust`（`src/extension.ts`）

- 参数：`AssetTreeItem`（仅从树右键进入；无 item 直接 return，与 `connect` 一致；命令面板里隐藏）。
- 流程：
  1. `current = configManager.resolveAssetTrust(item.asset.bastionId, item.asset.id)`。
  2. `showQuickPick` 三项：

     | label | description | detail |
     |---|---|---|
     | `t('Untrusted')` | 当前档时 `t('Current')` | `t('Every agent command asks for confirmation.')` |
     | `t('Limited trust')` | 同上 | `t('Commands are reviewed by @at-series/command-policy; only an allow verdict skips the prompt.')` |
     | `t('Full trust')` | 同上 | `t('Agent commands and SFTP writes run without prompts. Raw terminal input still asks.')` |

     placeholder：`t('Select trust level for {asset}', { asset: item.asset.name })`。QuickPick item 携带 `level: AssetCommandTrust` 字段，不按 label 反查。
  3. 取消 → return；选中 → `await configManager.setAssetTrust(bastionId, assetId, level)` → `treeProvider.refresh()` → `showTimedNotification(t('Trust level for {asset} is now {level}.', { asset, level: levelLabel }))`。
- 包一层现有 `runCommand` 错误处理。

### 7.3 package.json contributes

```jsonc
// commands
{ "command": "jumpserverManager.setAssetTrust", "title": "%atJumpServer.command.setAssetTrust.title%" }

// menus["view/item/context"]
{
  "command": "jumpserverManager.setAssetTrust",
  "when": "view == jumpserverManager.assets && (viewItem == jumpserverAsset || viewItem == jumpserverMysqlAsset || viewItem == jumpserverRedisAsset)",
  "group": "2_manage@1"
}

// menus["commandPalette"]（新增节；该命令没有 item 参数时无意义）
{ "command": "jumpserverManager.setAssetTrust", "when": "false" }
```

`jumpserverUnsupportedAsset` 不给菜单：连不上的资产没有 MCP 执行面，设信任无意义。

## 8. l10n / nls

### 8.1 package.nls（+ `zh-cn`，`npm run sync:l10n` 同步 `zh-hans` / `zh`）

| key | en | zh-cn |
|---|---|---|
| `atJumpServer.command.setAssetTrust.title` | `JumpServer: Set Asset Trust Level` | `JumpServer: 设置资产信任级别` |

### 8.2 运行时 bundle（`l10n/bundle.l10n.zh-cn.json`，同样 sync 别名）

三档译名与 At-Terminal 逐字一致（不信任 / 有限信任 / 完全信任）：

| English source (`t()` key) | zh-cn |
|---|---|
| `Untrusted` | `不信任` |
| `Limited trust` | `有限信任` |
| `Full trust` | `完全信任` |
| `Agent command trust` | `代理命令信任` |
| `Current` | `当前` |
| `Select trust level for {asset}` | `选择 {asset} 的信任级别` |
| `Every agent command asks for confirmation.` | `所有代理命令都需要弹窗确认。` |
| `Commands are reviewed by @at-series/command-policy; only an allow verdict skips the prompt.` | `命令由 @at-series/command-policy 审查，仅判定为 allow 时免确认。` |
| `Agent commands and SFTP writes run without prompts. Raw terminal input still asks.` | `代理命令与 SFTP 写入不再弹窗；终端原始输入仍需确认。` |
| `Trust level for {asset} is now {level}.` | `{asset} 的信任级别已设为 {level}。` |

`nls.test.ts` 会自动强制这些 key 的 zh-cn 存在与别名一致。

## 9. MCP tool catalog 文案（`src/mcp/toolCatalog.ts`）

三条命令工具（run_terminal_command / mysql_execute_sql / redis_execute_command）的 trust 语义描述**归姊妹计划 Task 8**（参照 At-Terminal `run_remote_command` 的三档措辞）。本设计负责其余（英文，不走 l10n）：

- `jumpserver_send_terminal_input`：追加 — `Always asks for confirmation regardless of the asset trust level.`
- 四个 SFTP 写工具（`sftp_write_file` / `sftp_create_file` / `sftp_create_directory` / `sftp_rename`）：描述中 `after confirmation` 改为 `after confirmation unless the asset is set to full trust`。
- `jumpserver_sftp_delete`：追加 — `Every delete asks for confirmation, even on a fully trusted asset.`

## 10. 测试（required）

| 区域 | 缺失该行为必须失败的断言 |
|---|---|
| `test/config/schema.test.ts` | `parseAssetCommandTrust` 三档通过、`'on'` / `true` / `undefined` → `none`；`parseAssetTrustOverlay` 丢弃非法值条目、非对象输入回 `{}`；`assetTrustKey` 拼接 |
| `test/config/JumpServerConfigManager.test.ts` | 默认 `resolveAssetTrust` 回 `none`；`setAssetTrust('full')` 后同步可读回；设回 `none` 后 globalState 里条目消失；`saveCachedAssets` 整体重写资产后信任幸存；`deleteBastion` 只清该堡垒机前缀条目、另一堡垒机同 assetId 的条目保留；`deleteSettings` 清空整个 key；`listAssetTrustOverrides` 可按堡垒机过滤 |
| `test/agent/JumpServerAgentToolService.test.ts`（本设计增量；trust×命令工具用例归姊妹计划 Task 7） | `full`：write/create/rename 不调用 `confirm` 即执行，`sftpDelete` 与 `sendTerminalInput` 仍调用 `confirm`；`none` / `policy`：SFTP 写工具照旧 `confirm`；`getConnectionAsset` 返回 undefined → 按 `none` 弹窗；**invoke-time 读取**：`resolveAssetTrust` mock 先回 `none` 再回 `full`，同一 service 实例第二次 SFTP 写不弹窗 |
| `test/tree/JumpServerTreeProvider.test.ts` | overlay 中 `full` 的资产 `description` 含 `Full trust` 后缀；无 overlay 方法的 source → description 与现状 byte 级一致；`id` / `contextValue` 不因信任改变 |
| `test/extension/ExtensionCommands.test.ts` | `setAssetTrust` 命令：QuickPick 选 `Full trust` → `configManager.setAssetTrust(bastionId, assetId, 'full')` 被调 → 树 refresh → toast；取消 QuickPick 不写；无 item 直接返回；当前档的 QuickPick 项 description 含 `Current` |
| `test/package.manifest.test.ts` | 新命令注册、menus `when` 值（含 `commandPalette` 隐藏）、nls key 存在 |
| `test/mcp/toolCatalog.test.ts` | `send_terminal_input` 描述含 `regardless`；四个 SFTP 写工具描述含 `unless the asset is set to full trust`；`sftp_delete` 描述含 `even on a fully trusted asset`（三条命令工具的描述断言归姊妹计划） |
| `test/i18n/nls.test.ts` | 新 `t()` key 的 zh-cn / 别名（现有测试自动覆盖，无需新写） |

## 11. 超出范围

- `@at-series/command-policy` 的加载、打包、`authorizeAssetCommand`、三条命令工具接线、只读启发式降权、三条命令工具的 catalog 描述（姊妹设计 / 姊妹计划）
- At-Terminal 式 SFTP 目录授权（grant TTL、敏感路径二次确认、`SftpWriteAuthorizer`）
- 后台连接（`backgroundConnectionAllowed`）及任何非用户打开终端的连接方式
- Configure 面板（`JumpServerConfigPanel` / `webview/jumpserver-config`）中的信任覆盖列表视图——树右键已闭环，面板列表留待后续需求
- 在 `jumpserver_list_assets` / `get_terminal_context` 摘要中输出 `commandTrust` 字段（未来可加，本期不做）
- 按堡垒机 / 按分组批量设信任、信任的导入导出
- audit log、决策遥测
- 版本号、CHANGELOG、市场 release notes（release note 里「默认收紧」条目由姊妹计划牵头，两计划同 release）

## 12. 架构草图

```text
jumpserverManager.setAssetTrust（树右键 → QuickPick）
        │ setAssetTrust(bastionId, assetId, level)
        ▼
JumpServerConfigManager ── globalState['jumpserverManager.assetTrust']
        │                        Record<`${bastionId}/${assetId}`, 'policy'|'full'>
        │ listAssetTrustOverrides()          resolveAssetTrust(bastionId, assetId)  ← 同步，每次 invoke
        ├────────────────────────────┐              │
        ▼                            ▼              ▼
JumpServerTreeProvider     extension.ts 注入 resolveAssetTrust: (asset) => …
  AssetTreeItem description          │
  「· 有限信任 / · 完全信任」          ▼
                           JumpServerAgentToolService
                             ├─ 命令工具 × trust → authorizeAssetCommand（姊妹设计）
                             │     policy 档懒加载 dist/policy-runtime.js
                             ├─ SFTP 写族：full → 跳过 confirm（delete 除外）；否则照旧（本设计 §6.2）
                             └─ sendTerminalInput：永远 confirm（不动）
```
