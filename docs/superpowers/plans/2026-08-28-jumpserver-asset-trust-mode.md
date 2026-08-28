# 资产三层命令信任模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个资产可设 `none` / `policy` / `full` 三档信任（不信任 / 有限信任 / 完全信任）并本地持久化：树右键设置、树上可见、刷新 / 重连幸存、改动对下一次 MCP 调用立即生效。本计划落地 trust 的**存储、resolver、SFTP 写族确认门、树 UI、命令、l10n、非命令工具的 catalog 文案**；三条命令工具（SSH / MySQL / Redis）× trust 的授权接线归姊妹计划。

**Architecture:** overlay map `jumpserverManager.assetTrust`（globalState，键 `${bastionId}/${assetId}`，只存 `policy` / `full`）由 `JumpServerConfigManager` 管理，暴露同步 `resolveAssetTrust`（每次 invoke 现读，写后缓存失效）；`extension.ts` 把它注入 `JumpServerAgentToolService` 的 `resolveAssetTrust` 依赖（姊妹计划定义的接缝，缺省恒 `'none'`）；SFTP 写族在 service 内新增 `requireSftpWriteConfirm`（`full` 跳过，镜像 At-Terminal `shouldAutoApproveSftpWrite`）；树右键 `jumpserverManager.setAssetTrust` + QuickPick 设置；`AssetTreeItem` description 显示非默认档。

**Tech Stack:** TypeScript, Zod, Vitest, VS Code TreeView / QuickPick / globalState, `vscode.l10n` via `t()`。

**Branch:** 本设计与姊妹 command-policy 设计同在 `cursor-plan`（基线 `cursor/perf-remaining-impl-fb4b`）。**推荐合入顺序**与姊妹计划互锁：command-policy Phase A（惰性引擎）→ 本计划（存储 / UI / SFTP 门）→ command-policy Phase B（真评估器注入）。两计划按同名同签名定义 `JumpServerAgentToolServiceDependencies.resolveAssetTrust?: (asset: CachedJumpServerAsset) => AssetCommandTrust`——先落地者创建该字段与 `trustOf` helper，后落地者复用。若本计划单独先合：命令工具暂不消费 trust（SSH 保持每次确认、MySQL/Redis 保持只读免确认，`full` 暂只对 SFTP 写族生效、删除仍确认）；若仅合入 command-policy Phase A：行为不变。建议同一 release。

**Spec:** `docs/superpowers/specs/2026-08-28-jumpserver-asset-trust-mode-design.md`
**Sibling:** `docs/superpowers/specs/2026-08-28-jumpserver-command-policy-integration-design.md` + `docs/superpowers/plans/2026-08-28-jumpserver-command-policy-integration.md`

**TDD:** 每个任务先写失败测试、看到 RED，再实现。提交信息用 HEREDOC。不改 git config，不跳过 hooks。

---

## File map

| File | Responsibility |
|---|---|
| Modify `src/config/schema.ts` | `ASSET_COMMAND_TRUST_LEVELS` / `AssetCommandTrust` / `parseAssetCommandTrust` / `assetTrustKey` / `parseAssetTrustOverlay`（Task 1） |
| Modify `src/config/JumpServerConfigManager.ts` | 同步 `resolveAssetTrust` + `setAssetTrust` / `listAssetTrustOverrides` + `deleteBastion` / `deleteSettings` 清理（Task 2） |
| Modify `src/agent/JumpServerAgentToolService.ts` | `resolveAssetTrust?` 依赖（若姊妹计划未先建）+ `requireSftpWriteConfirm`；命令工具与 `sendTerminalInput` 不动（Task 3） |
| Modify `src/extension.ts` | 注入 `resolveAssetTrust`；注册 `jumpserverManager.setAssetTrust`；树 source 接 overlay（Task 3 / 5） |
| Modify `src/tree/TreeItems.ts` | `AssetTreeItem` 可选 `trust` 参数 → description / tooltip 后缀（Task 4） |
| Modify `src/tree/JumpServerTreeProvider.ts` | source 可选 `listAssetTrustOverrides`，构造 AssetTreeItem 时查 overlay（Task 4） |
| Modify `src/mcp/toolCatalog.ts` | `send_terminal_input` + 四个 SFTP 写工具 + `sftp_delete` 描述（Task 6；三条命令工具的描述归姊妹计划 Task 8） |
| Modify `package.json` + `package.nls.json` + `package.nls.zh-cn.json` | 命令、`view/item/context` 菜单、`commandPalette` 隐藏（Task 5） |
| Modify `l10n/bundle.l10n.zh-cn.json` | 新 `t()` key（跑 `npm run sync:l10n` 同步 zh-hans / zh 与 nls 别名）（Task 4 / 5） |
| Tests per task | `test/config/schema.test.ts`、`test/config/JumpServerConfigManager.test.ts`、`test/agent/JumpServerAgentToolService.test.ts`、`test/tree/JumpServerTreeProvider.test.ts`、`test/extension/ExtensionCommands.test.ts`、`test/package.manifest.test.ts`、`test/mcp/toolCatalog.test.ts` |

不做：`authorizeAssetCommand` / policy-runtime / 命令工具接线 / `SqlSafety`、`RedisSafety` 只读启发式降权 / 三条命令工具 catalog 描述（全归姊妹计划）、SFTP 目录授权、后台连接、Configure 面板覆盖列表、list_assets 摘要加 trust 字段、版本号 / CHANGELOG。

---

### Task 1: schema — 信任级别、overlay 键与防御式解析

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `test/config/schema.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import {
  assetTrustKey,
  parseAssetCommandTrust,
  parseAssetTrustOverlay
} from '../../src/config/schema';

it('parses the three trust levels and falls back to none', () => {
  expect(parseAssetCommandTrust('none')).toBe('none');
  expect(parseAssetCommandTrust('policy')).toBe('policy');
  expect(parseAssetCommandTrust('full')).toBe('full');
  expect(parseAssetCommandTrust('on')).toBe('none');
  expect(parseAssetCommandTrust(true)).toBe('none');
  expect(parseAssetCommandTrust(undefined)).toBe('none');
});

it('builds the overlay key from bastionId and assetId', () => {
  expect(assetTrustKey('b1', 'a1')).toBe('b1/a1');
});

it('drops overlay entries whose value is not policy or full', () => {
  expect(parseAssetTrustOverlay({
    'b1/a1': 'full',
    'b1/a2': 'policy',
    'b1/a3': 'none',
    'b1/a4': 'yes',
    'b1/a5': 1
  })).toEqual({ 'b1/a1': 'full', 'b1/a2': 'policy' });
  expect(parseAssetTrustOverlay(undefined)).toEqual({});
  expect(parseAssetTrustOverlay([])).toEqual({});
  expect(parseAssetTrustOverlay('junk')).toEqual({});
});
```

- [ ] **Step 2: RED**

Run: `npm test -- test/config/schema.test.ts`

Expected: FAIL — `parseAssetCommandTrust` is not exported。

- [ ] **Step 3: Implement**

按 spec §4.1 原样加入 `ASSET_COMMAND_TRUST_LEVELS`、`AssetCommandTrust`、`parseAssetCommandTrust`、`assetTrustKey`、`parseAssetTrustOverlay`。`'none'` 永不落盘，overlay 值域仅 `'policy' | 'full'`。

类型归属说明（spec D1）：若姊妹计划已先落地，`src/agent/assetCommandTrust.ts` 里有本地声明的同名同构 `AssetCommandTrust`——不阻塞、不冲突（string union 结构兼容）；本任务落地后顺手把该文件改成 `import type { AssetCommandTrust } from '../config/schema'` 并删除本地声明（一行改动，行为不变；若姊妹未落地则无事可做）。

- [ ] **Step 4: GREEN**

Run: `npm test -- test/config/schema.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add asset command trust levels and overlay schema

EOF
)"
```

---

### Task 2: 配置管理 — overlay 持久化、同步 resolver 与生命周期

**Files:**
- Modify: `src/config/JumpServerConfigManager.ts`
- Modify: `test/config/JumpServerConfigManager.test.ts`

- [ ] **Step 1: Write failing tests**（沿用 `MemoryMemento` / `MemorySecretStore` / `asset()` helpers）

```ts
it('defaults every asset to untrusted and persists non-default levels', async () => {
  const globalState = new MemoryMemento();
  const manager = new JumpServerConfigManager(globalState, new MemorySecretStore());

  expect(manager.resolveAssetTrust('b1', 'a1')).toBe('none');

  await manager.setAssetTrust('b1', 'a1', 'full');
  expect(manager.resolveAssetTrust('b1', 'a1')).toBe('full');   // 同步、写后立即可见
  expect(globalState.data.get('jumpserverManager.assetTrust')).toEqual({ 'b1/a1': 'full' });

  await manager.setAssetTrust('b1', 'a1', 'none');
  expect(globalState.data.get('jumpserverManager.assetTrust')).toEqual({});
  expect(manager.resolveAssetTrust('b1', 'a1')).toBe('none');
});

it('keeps trust across an asset cache refresh', async () => {
  const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
  await manager.setAssetTrust('b1', 'a1', 'policy');

  await manager.saveCachedAssets('b1', [asset({ id: 'a1', bastionId: 'b1' })]);
  await manager.saveCachedAssets('b1', []); // refresh 期间资产可以整体消失

  expect(manager.resolveAssetTrust('b1', 'a1')).toBe('policy');
});

it('deleteBastion clears only that bastion trust entries', async () => {
  const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
  await manager.saveBastion(bastion({ id: '11111111-1111-1111-1111-111111111111' }));
  await manager.setAssetTrust('11111111-1111-1111-1111-111111111111', 'a1', 'full');
  await manager.setAssetTrust('22222222-2222-2222-2222-222222222222', 'a1', 'full');

  await manager.deleteBastion('11111111-1111-1111-1111-111111111111');

  expect(manager.resolveAssetTrust('11111111-1111-1111-1111-111111111111', 'a1')).toBe('none');
  expect(manager.resolveAssetTrust('22222222-2222-2222-2222-222222222222', 'a1')).toBe('full');
});

it('deleteSettings clears the whole trust overlay', async () => {
  const globalState = new MemoryMemento();
  const manager = new JumpServerConfigManager(globalState, new MemorySecretStore());
  await manager.setAssetTrust('b1', 'a1', 'full');

  await manager.deleteSettings();

  expect(globalState.data.get('jumpserverManager.assetTrust')).toBeUndefined();
});

it('lists overrides optionally filtered by bastion', async () => {
  const manager = new JumpServerConfigManager(new MemoryMemento(), new MemorySecretStore());
  await manager.setAssetTrust('b1', 'a1', 'full');
  await manager.setAssetTrust('b2', 'a1', 'policy');

  await expect(manager.listAssetTrustOverrides()).resolves.toEqual({ 'b1/a1': 'full', 'b2/a1': 'policy' });
  await expect(manager.listAssetTrustOverrides('b2')).resolves.toEqual({ 'b2/a1': 'policy' });
});

it('resolves trust from a corrupt overlay as none', () => {
  const globalState = new MemoryMemento();
  globalState.data.set('jumpserverManager.assetTrust', { 'b1/a1': 'yes', junk: 42 });
  const manager = new JumpServerConfigManager(globalState, new MemorySecretStore());
  expect(manager.resolveAssetTrust('b1', 'a1')).toBe('none');
});
```

若现有测试没有 `bastion()` helper，就地内联一个合法 `JumpServerBastion` 字面量。

- [ ] **Step 2: RED**

Run: `npm test -- test/config/JumpServerConfigManager.test.ts`

Expected: FAIL — `resolveAssetTrust` is not a function。

- [ ] **Step 3: Implement**

- 常量 `const ASSET_TRUST_KEY = 'jumpserverManager.assetTrust';`，私有 `assetTrustCache?: Record<string, 'policy' | 'full'>`。
- 私有读 helper（**同步**；该 key 不参与 legacy 迁移，不调 `migrateIfNeeded`）：`this.assetTrustCache ??= parseAssetTrustOverlay(this.globalState.get<unknown>(ASSET_TRUST_KEY, {}))`。
- `resolveAssetTrust(bastionId, assetId)`（同步）= `overlay[assetTrustKey(bastionId, assetId)] ?? 'none'`。
- `setAssetTrust`（async）：读 overlay 拷贝、`'none'` 删键否则赋值、`await globalState.update`、`this.assetTrustCache = undefined`。
- `listAssetTrustOverrides(bastionId?)`（async，签名与其他 list 方法一致）：可选 `${bastionId}/` 前缀过滤，返回浅拷贝。
- `deleteBastion`：现有资产 / 节点清理旁追加 overlay 前缀清理并 update + 缓存失效。
- `deleteSettings`：`update(ASSET_TRUST_KEY, undefined)` + 缓存失效。

- [ ] **Step 4: GREEN**

Run: `npm test -- test/config/JumpServerConfigManager.test.ts test/config/schema.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config/JumpServerConfigManager.ts test/config/JumpServerConfigManager.test.ts
git commit -m "$(cat <<'EOF'
feat: persist per-asset command trust overlay in config manager

EOF
)"
```

---

### Task 3: service — `resolveAssetTrust` 注入 + SFTP 写族确认门

**Files:**
- Modify: `src/agent/JumpServerAgentToolService.ts`
- Modify: `src/extension.ts`（注入 resolver）
- Modify: `test/agent/JumpServerAgentToolService.test.ts`

边界提醒：三条命令工具（`runTerminalCommand` / `mysqlExecuteSql` / `redisExecuteCommand`）与 `sendTerminalInput` 在本任务**零改动**——命令工具 × trust 归姊妹计划 Task 7。若姊妹计划已合入，`resolveAssetTrust?` 字段与 `trustOf` helper 已存在，本任务直接复用；否则按下述与其逐字一致的定义先行创建。

- [ ] **Step 1: Write failing tests**

```ts
const withTrust = (level: AssetCommandTrust) => ({ resolveAssetTrust: () => level });

it('fully trusted assets skip sftp write confirmations but still confirm deletes', async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const service = serviceWith({ confirm, ...withTrust('full'), sftp: sftpMockWithAsset() });
  await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });
  await service.sftpCreateFile({ path: '/tmp/g' });
  await service.sftpCreateDirectory({ path: '/tmp/d' });
  await service.sftpRename({ oldPath: '/tmp/f', newPath: '/tmp/f2' });
  expect(confirm).not.toHaveBeenCalled();
  await service.sftpDelete({ path: '/tmp/g' });
  expect(confirm).toHaveBeenCalledOnce();
});

it('untrusted and policy-trusted assets still confirm sftp writes', async () => {
  for (const level of ['none', 'policy'] as const) {
    const confirm = vi.fn().mockResolvedValue(true);
    const service = serviceWith({ confirm, ...withTrust(level), sftp: sftpMockWithAsset() });
    await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });
    expect(confirm).toHaveBeenCalledOnce();
  }
});

it('an sftp connection without a resolvable asset stays untrusted', async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const service = serviceWith({
    confirm,
    ...withTrust('full'),
    sftp: sftpMock({ getConnectionAsset: () => undefined })
  });
  await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });
  expect(confirm).toHaveBeenCalledOnce();   // 解析不出资产 → none → 弹窗
});

it('send_terminal_input confirms even under full trust', async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const service = serviceWith({ confirm, ...withTrust('full'), terminalContext: sshTerminal() });
  await service.sendTerminalInput({ input: 'echo hi\n' });
  expect(confirm).toHaveBeenCalledOnce();
});

it('reads the trust resolver at invoke time, not at connect time', async () => {
  const levels: AssetCommandTrust[] = ['none', 'full'];
  const confirm = vi.fn().mockResolvedValue(true);
  const service = serviceWith({
    confirm,
    resolveAssetTrust: () => levels.shift() ?? 'full',
    sftp: sftpMockWithAsset()
  });
  await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });  // none → confirm
  await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });  // full → no confirm
  expect(confirm).toHaveBeenCalledOnce();
});

it('defaults to untrusted when no resolver is injected', async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const service = serviceWith({ confirm, sftp: sftpMockWithAsset() });  // resolveAssetTrust 缺省
  await service.sftpWriteFile({ path: '/tmp/f', content: 'x' });
  expect(confirm).toHaveBeenCalledOnce();
});
```

`sftpMockWithAsset()` = 现有 sftp mock + `getConnectionAsset: () => asset({ id: 'a1', bastionId: 'b1' })`。TypeScript 会把 `resolveAssetTrust` 标为可选，既有用例无需改动。

- [ ] **Step 2: RED**

Run: `npm test -- test/agent/JumpServerAgentToolService.test.ts`

Expected: FAIL — `full` 下 SFTP 写仍然 confirm / `resolveAssetTrust` 未被消费。

- [ ] **Step 3: Implement**

- 依赖（若不存在则创建，与姊妹计划 Task 7 逐字一致）：

```ts
/** 资产 trust 解析，由 trust-mode 设计提供；缺省一律 'none'（最严）。 */
resolveAssetTrust?: (asset: CachedJumpServerAsset) => AssetCommandTrust;

private trustOf(asset: CachedJumpServerAsset): AssetCommandTrust {
  return this.dependencies.resolveAssetTrust?.(asset) ?? 'none';
}
```

- 私有 gate（spec §6.2），四个 SFTP 写工具（write / create file / create directory / rename）把 `await this.requireConfirm(msg)` 换成 `await this.requireSftpWriteConfirm(input, msg)`。**`sftpDelete` 继续走 `requireConfirm`，任何 trust 都不跳过。**

```ts
private async requireSftpWriteConfirm(
  input: { connectionKey?: string; terminalId?: string },
  message: string
): Promise<void> {
  const asset = this.dependencies.sftp.getConnectionAsset(connectionKeyOf(input));
  if (asset && this.trustOf(asset) === 'full') {
    return;
  }
  await this.requireConfirm(message);
}
```

- `extension.ts` 构造 service 时注入：`resolveAssetTrust: (asset) => configManager.resolveAssetTrust(asset.bastionId, asset.id)`。

- [ ] **Step 4: GREEN**

Run: `npm test -- test/agent/JumpServerAgentToolService.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/agent/JumpServerAgentToolService.ts src/extension.ts test/agent/JumpServerAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat: gate sftp writes on per-asset trust and wire the resolver

EOF
)"
```

---

### Task 4: 树装饰

**Files:**
- Modify: `src/tree/TreeItems.ts`
- Modify: `src/tree/JumpServerTreeProvider.ts`
- Modify: `test/tree/JumpServerTreeProvider.test.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json`（`Untrusted` / `Limited trust` / `Full trust` / `Agent command trust`），跑 `npm run sync:l10n`

- [ ] **Step 1: Write failing tests**

```ts
it('marks non-default trust in the asset description and tooltip', async () => {
  const provider = new JumpServerTreeProvider({
    listBastions: async () => [bastion('b1')],
    listCachedAssets: async () => [shared('b1', 'asset-1'), shared('b1', 'asset-2')],
    listCachedAssetNodes: async () => [],
    listAssetTrustOverrides: async () => ({ 'b1/asset-1': 'full' })
  });
  const [root] = await provider.getChildren();
  const group = (await provider.getChildren(root))[0] as GroupTreeItem;
  const [trusted, untrusted] = await provider.getChildren(group) as AssetTreeItem[];

  expect(String(trusted.description)).toMatch(/Full trust$/);
  expect(String(trusted.tooltip)).toContain('Agent command trust');
  expect(String(untrusted.description)).not.toMatch(/trust/i);
  expect(trusted.id).toBe('asset:b1/asset-1');          // id / contextValue 不因信任改变
  expect(trusted.contextValue).toBe(untrusted.contextValue);
});

it('renders unchanged when the source has no trust overlay method', async () => {
  /* 不带 listAssetTrustOverrides 的 source → description 与既有断言 byte 级一致 */
});
```

- [ ] **Step 2: RED**

Run: `npm test -- test/tree/JumpServerTreeProvider.test.ts`

- [ ] **Step 3: Implement**

- `JumpServerAssetSource` 加可选 `listAssetTrustOverrides?(): Promise<Record<string, 'policy' | 'full'>>`。
- `getChildren` 产出资产的两个分支各取一次 `await this.source.listAssetTrustOverrides?.() ?? {}`，`new AssetTreeItem(asset, overlay[assetTrustKey(asset.bastionId, asset.id)] ?? 'none')`。
- `AssetTreeItem` 构造函数第二参数 `trust: AssetCommandTrust = 'none'`：`policy` / `full` 时 description 追加 ` · ${t('Limited trust')}` / ` · ${t('Full trust')}`；tooltip 追加 `\n${t('Agent command trust')}: ${label}`（`none` 用 `t('Untrusted')`）。不设 iconPath，不改 `contextValue` / `id` / `command`。
- `extension.ts` 树 source 传入 `listAssetTrustOverrides: () => configManager.listAssetTrustOverrides()`。

- [ ] **Step 4: GREEN**

Run: `npm test -- test/tree/JumpServerTreeProvider.test.ts test/i18n/nls.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/tree/TreeItems.ts src/tree/JumpServerTreeProvider.ts src/extension.ts \
  test/tree/JumpServerTreeProvider.test.ts l10n/
git commit -m "$(cat <<'EOF'
feat: show per-asset trust level on the asset tree

EOF
)"
```

---

### Task 5: 设置命令 + manifest + l10n

**Files:**
- Modify: `package.json`（command、`view/item/context`、`commandPalette` when:false）
- Modify: `package.nls.json` / `package.nls.zh-cn.json`（`atJumpServer.command.setAssetTrust.title`），跑 `npm run sync:l10n`
- Modify: `src/extension.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json`（QuickPick / toast 文案，见 spec §8.2）
- Modify: `test/extension/ExtensionCommands.test.ts`
- Modify: `test/package.manifest.test.ts`

- [ ] **Step 1: Write failing tests**

manifest 测试：`jumpserverManager.setAssetTrust` 在 `contributes.commands`；`view/item/context` 的 `when` 覆盖 `jumpserverAsset || jumpserverMysqlAsset || jumpserverRedisAsset` 且不含 `jumpserverUnsupportedAsset`；`commandPalette` 里 `when: "false"`。

命令测试（沿用 `contextWithSettings` / 命令注册捕获模式）：

```ts
it('setAssetTrust writes the picked level and refreshes the tree', async () => {
  /* showQuickPick mock 返回 level === 'full' 的项 →
     configManager.setAssetTrust('b1', 'asset-1', 'full') 被调，
     tree onDidChangeTreeData fire，toast 出现 */
});

it('setAssetTrust does nothing when the QuickPick is dismissed or the item is missing', async () => {
  /* showQuickPick → undefined 以及 无 item 两条路径都不调 setAssetTrust */
});

it('marks the current level in the QuickPick', async () => {
  /* resolveAssetTrust → 'policy'；捕获 showQuickPick items，
     level==='policy' 项 description 含 Current，其余不含 */
});
```

- [ ] **Step 2: RED**

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts`

- [ ] **Step 3: Implement**

spec §7.2 / §7.3 / §8：QuickPick 三项（label = `t('Untrusted')` / `t('Limited trust')` / `t('Full trust')`，detail = 各档说明，当前档 description = `t('Current')`，item 携带 `level: AssetCommandTrust` 字段），placeholder `t('Select trust level for {asset}', …)`；选中后 `setAssetTrust` → `treeProvider.refresh()` → `showTimedNotification(t('Trust level for {asset} is now {level}.', …))`；包 `runCommand`。

- [ ] **Step 4: GREEN**

Run: `npm test -- test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts test/i18n/nls.test.ts`

- [ ] **Step 5: Commit**

```bash
git add package.json package.nls.json package.nls.zh-cn.json package.nls.zh-hans.json package.nls.zh.json \
  l10n/ src/extension.ts test/extension/ExtensionCommands.test.ts test/package.manifest.test.ts
git commit -m "$(cat <<'EOF'
feat: set per-asset trust level from the asset tree context menu

EOF
)"
```

---

### Task 6: MCP catalog 文案（非命令工具）+ 文档 + 全量回归

**Files:**
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `test/mcp/toolCatalog.test.ts`
- Modify: `README.md` / `docs/features.md`（如有对应表格）：一段说明三档语义（三条命令工具的行为差异与 release note 由姊妹计划牵头，此处只补 SFTP / send-input / 树 UI / 默认 `none`）

三条命令工具的 trust 描述归姊妹计划 Task 8，本任务不碰。

- [ ] **Step 1: Write failing tests**

```ts
it('documents that send_terminal_input always confirms', () => {
  const entry = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === 'jumpserver_send_terminal_input');
  expect(entry?.description).toMatch(/regardless of the asset trust level/);
});

it('documents the full-trust skip on sftp write tools, but not delete', () => {
  for (const name of [
    'jumpserver_sftp_write_file', 'jumpserver_sftp_create_file',
    'jumpserver_sftp_create_directory', 'jumpserver_sftp_rename'
  ]) {
    const entry = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === name);
    expect(entry?.description, name).toMatch(/unless the asset is set to full trust/);
  }
  const del = AT_JUMPSERVER_TOOL_CATALOG.find((tool) => tool.name === 'jumpserver_sftp_delete');
  expect(del?.description).toMatch(/even on a fully trusted asset/);
});
```

- [ ] **Step 2: RED**

Run: `npm test -- test/mcp/toolCatalog.test.ts`

- [ ] **Step 3: Implement**

按 spec §9 更新描述（英文，不走 l10n）。README / features 补三档说明（不信任 / 有限信任 / 完全信任，默认不信任；树右键设置；SFTP 写入仅完全信任免确认，删除永远确认；终端原始输入永远确认）。

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc --noEmit`

Expected: PASS，0 failures。

- [ ] **Step 5: Commit**

```bash
git add src/mcp/toolCatalog.ts test/mcp/toolCatalog.test.ts README.md docs/
git commit -m "$(cat <<'EOF'
docs: describe asset trust behavior on sftp and terminal-input tools

EOF
)"
```

---

## 跨计划集成验收（两计划都合入后，任一侧收尾时执行）

- [ ] `src/agent/assetCommandTrust.ts` 的 `AssetCommandTrust` 已收敛为 `import type` 自 `src/config/schema.ts`（Task 1 备注）。
- [ ] 手工冒烟（对应姊妹计划 §7.3）：资产设 `policy` 后 `uptime` 不弹窗、`rm /tmp/x` 弹窗附 policy 摘要；设 `none` 后 `SELECT 1` 弹窗；设 `full` 后任意命令与 SFTP 写（非 delete）不弹窗、`sftp_delete` 与 `send_terminal_input` 仍弹窗；改档后**不重连**直接重发 MCP 调用即生效。
- [ ] release note 含默认 `none` 的确认收紧说明（姊妹计划牵头，同一 release）。

## Spec coverage

| Spec | Task |
|---|---|
| §4 schema / overlay 解析（D1, D3, D4, D5, D13） | 1 |
| §5 config manager API + 生命周期 + 同步 resolver（D5, D6） | 2 |
| §6.2 SFTP 门 + §6.1 resolver 注入（D6, D8, D9, D11） | 3 |
| §7.1 树装饰（D10） | 4 |
| §7.2–§8 命令 / manifest / l10n（D2, D10） | 5 |
| §9 catalog（send-input / SFTP）+ 文档 | 6 |
| §3 命令工具 × trust、§9 命令工具描述 | 姊妹计划（Task 5 / 7 / 8） |
| §11 out of scope（后台连接 D12、面板列表、目录授权等） | 不做 |

## Type names（do not drift）

- `AssetCommandTrust` / `ASSET_COMMAND_TRUST_LEVELS` / `parseAssetCommandTrust` / `parseAssetTrustOverlay` / `assetTrustKey`（`src/config/schema.ts`）
- `resolveAssetTrust(bastionId, assetId)`（同步）/ `setAssetTrust` / `listAssetTrustOverrides`，globalState key `jumpserverManager.assetTrust`
- service 依赖 `resolveAssetTrust?: (asset: CachedJumpServerAsset) => AssetCommandTrust`（与姊妹计划同名同签名）、私有 `trustOf` / `requireSftpWriteConfirm`
- 命令 id `jumpserverManager.setAssetTrust`，nls key `atJumpServer.command.setAssetTrust.title`
- l10n 三档：`Untrusted` 不信任 / `Limited trust` 有限信任 / `Full trust` 完全信任（与 At-Terminal 译名逐字一致）
