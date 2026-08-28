# JumpServer 接入 `@at-series/command-policy` Design

**Date:** 2026-08-28  
**Status:** Proposal — implementation plan: `docs/superpowers/plans/2026-08-28-jumpserver-command-policy-integration.md`  
**Policy package:** `@at-series/command-policy@0.1.1`（npm 已发布；**精确锁定**，禁止 `^`/`~`/`file:`；默认不修改 command-policy 源码，不发新版本）  
**Reference implementation:** At-Terminal（`src/policy-runtime/index.ts`、`src/agent/loadRemoteCommandPolicy.ts`、`src/agent/remoteCommandAuthorization.ts`、esbuild policy-runtime bundle）

**Anchors:**

- command-policy 契约：`at-series-command-policy` 仓库 `docs/api.md` + `README.md`（"Bundled consumers" 一节是 esbuild 配方的唯一真源）
- 现状代码：`src/agent/JumpServerAgentToolService.ts`、`src/agent/SqlSafety.ts`、`src/agent/RedisSafety.ts`、`src/agent/TerminalExecutors.ts`、`esbuild.config.mjs`、`src/mcp/toolCatalog.ts`
- **姊妹设计（trust 存储 / 授权门骨架 / UI，必须先读；两份设计共享同一组产品决策）：**
  - `docs/superpowers/specs/2026-08-28-jumpserver-asset-trust-mode-design.md`
  - `docs/superpowers/plans/2026-08-28-jumpserver-asset-trust-mode.md`

---

## 1. Goal

把 AT JumpServer Terminal 的三条命令执行工具（SSH `jumpserver_run_terminal_command`、MySQL `jumpserver_mysql_execute_sql`、Redis `jumpserver_redis_execute_command`）接到 `@at-series/command-policy` 的确定性分析器上：在资产 trust 为 `policy`（limited trust）时，库判 `allow` 的命令跳过确认，`review` / `deny` 仍确认（fail closed）；`none` 一律确认且不加载策略代码；`full` 跳过命令确认且不加载策略代码。策略引擎打成独立的 `dist/policy-runtime.js` CJS bundle + `dist/policy-assets/` WASM，`dist/extension.js` 保持零策略代码（镜像现有 `mcpRuntime` external 拆分）。

库只分析文本、只返回 `PolicyDecision`；trust 映射、确认 UI、执行、日志全部留在插件侧。trust 三级挂在**资产**上、默认 `none`——存储 / schema（`AssetCommandTrust` in `src/config/schema.ts`）、授权门骨架（`src/agent/assetCommandTrust.ts` 的 `authorizeAssetCommand`）、树 UI 与命令均归姊妹设计所有；**本设计交付引擎与评估入口，并在姊妹接线落地后把门里的注入分析器换成真 policy 评估器**（见 D14 分阶段）。

## 2. Decisions (grill)

| # | Decision |
|---|----------|
| D1 | 依赖精确锁定：`"@at-series/command-policy": "0.1.1"`（main 分支当前版本）。安全边界不用 `^`/`~`，不用 `file:` |
| D2 | trust 三级 `none` \| `policy` \| `full` 挂在**资产**上，默认 `none`。类型单一来源 = 姊妹设计的 `src/config/schema.ts`（`AssetCommandTrust`）；读取 = 姊妹设计的 `configManager.resolveAssetTrust(bastionId, assetId)`（invoke-time，**同步**，Memento.get + 写后失效 memoize）；分流 = 姊妹设计的 `authorizeAssetCommand`（`src/agent/assetCommandTrust.ts`）。本设计不另设 trust 通道 |
| D3 | `none`：不加载 policy runtime，命令一律确认。**这比现状更严**——`isReadOnlySql` / `isReadOnlyRedisCommand` 的"只读免确认"通道被撤销（见 D8） |
| D4 | `policy`：懒加载 `dist/policy-runtime.js`；`allow` 跳过确认；`review` / `deny` 仍弹确认（`deny` 用更强警示文案），**不静默拒绝**——除非域内契约已先行硬拒绝（如 Redis blocking 命令）。任何加载失败 / 异常 / 非法 action 一律视同 `review`（fail closed，`reasonCode: 'policy.initialization_failed'`，与姊妹设计 §6.1 的降级语义一致） |
| D5 | `full`：不加载 policy runtime，跳过命令确认 |
| D6 | `jumpserver_send_terminal_input` **不评估、永远确认**，任何 trust 级别都不放行（command-policy 文档明确 `sendTerminalInput` stays always-confirm）。SFTP 写族确认策略（`shouldAutoApproveSftpWrite`）归姊妹设计，本设计不动 |
| D7 | 评估**将要执行的那份文本**，决策后不得改写：SSH 评 `normalizeShellCommand(command)`（`wrapShellCommand` 里 `eval` 的正是它），`cwd` 单独传、绝不拼进命令；MySQL 评 `ensureSemicolon(sql)`（executor 发送的正文）；Redis 评 `command.trim()`。评估与 executor 用**同一个导出函数**产生文本，用单测锚定不漂移。`authorizeAssetCommand` 的 `command` 形参承载的就是这份"将执行文本"（确认框预览仍用原始输入） |
| D8 | `isReadOnlySql` / `isReadOnlyRedisCommand` **失去授权权力**：`policy` 档的 mysql / redis 分支从姊妹计划的只读启发式**迁移到** `createMysqlPolicyEvaluator` / `createRedisPolicyEvaluator`。两个函数保留为确认文案措辞选择器（姊妹设计 §6.2 的 `'Run state-changing …'` vs `'Run JumpServer MySQL SQL'` 措辞规则需要），不再决定免确认。`RedisSafety.isBlockingRedisCommand` **保留**，在 trust 判定与 policy 评估**之前**硬拒绝（防挂死 collector 是执行域契约，不是策略问题） |
| D9 | SSH 命令**只**走 `createShellPolicyEvaluator`——shell 分析器对静态 `python3 -c` / `mysql -e` / `sqlite3` / `redis-cli` 载荷已内嵌再入分析，禁止再叠一层 mysql evaluator 造成双评估 |
| D10 | 独立 `dist/policy-runtime.js` CJS bundle：esbuild `banner` + `define 'import.meta.url'` **强制**（漏配无任何报错，只会让 `python3 -c` 全部静默 review）；`copyPolicyAssets` 复制全部 3 个 WASM 到 `dist/policy-assets/`（不用 `include` 过滤——post-bundle smoke 要求 `python3 -c "print(1)"` 为 `allow`）；运行时经 `assetResolver` 读字节 |
| D11 | `dist/extension.js` 零策略代码：加载器 `src/agent/loadCommandPolicy.ts` 用 `createRequire(__filename)` + 运行时 `join(__dirname, 'policy-runtime.js')` 懒 require（esbuild 不会内联非字面量路径），失败回退 unavailable runtime（恒 `review`）；测试经 `setCommandPolicyLoaderForTests` 注入。镜像现有 `mcpRuntime.js` 拆分思路 |
| D12 | 确认框可附加库返回的 `evidence[].summary`（永远 redacted，最多展示 3 条）与 `reasonCode`；展示格式由本设计 §4.4 规定（姊妹设计明文遵循本设计）。**绝不**把 sourceText / cwd / parser 错误放进 riskSummaries 或日志（库侧已保证，插件侧不得自行添加） |
| D13 | 不修改 mcp-hub 源码；不给 command-policy 发新版本，除非实现中证明 0.1.1 有真实 gap（先停下来向用户举证） |
| D14 | **分阶段与模块所有权**：Phase A（本设计，惰性、零行为变化）= 依赖 + bundle + 加载器 + 评估入口 + 冒烟，先行合入；trust-mode 计划随后合入（门 + 接线，ssh 缺省评估器为 throw-stub、mysql/redis 暂用只读启发式，降级 = 弹窗）；Phase B（本设计）= 把 `assetCommandTrust.ts` 里的注入分析器换成真 policy 评估器并接好精确文本。`src/agent/assetCommandTrust.ts` 与 service 接线的**创建**归姊妹计划，本设计只做注入替换与签名扩展 |

## 3. Architecture

### 3.1 调用链（Phase B 完成后，以 SSH 为例）

```text
jumpserver_run_terminal_command (MCP invoke)
  └─ JumpServerAgentToolService.runTerminalCommand
       ├─ trust = this.trustOf(target.asset)                  // 姊妹设计：configManager.resolveAssetTrust（同步）
       ├─ authorizeAssetCommand({                             // 姊妹设计：src/agent/assetCommandTrust.ts
       │      trust, kind: 'ssh',
       │      command: normalizeShellCommand(command),        // D7：将执行文本
       │      cwd: input.cwd,                                 // 单独传，绝不拼进命令
       │      evaluateShellPolicy: evaluateShellCommandPolicy // 本设计：loadCommandPolicy 导出
       │    })
       │    ├─ trust 'full'   → { autoApprove: true }         // 不 require policy-runtime
       │    ├─ trust 'none'   → { autoApprove: false }        // 不 require policy-runtime
       │    └─ trust 'policy' → evaluateShellCommandPolicy(…)
       │          └─ 懒 require dist/policy-runtime.js → createShellPolicyEvaluator({ assetResolver })
       │               → { action, reasonCode, riskSummaries }（异常 / 非法 action ⇒ review）
       ├─ autoApprove ? 跳过确认
       │              : confirm(formatCommandConfirmMessage({ …, policyNote, riskSummaries }))
       └─ enqueueTerminal → shellExecutor.execute
            └─ wrapShellCommand 内部 eval quotePosix(normalizeShellCommand(command))
               ⇒ 执行文本 ≡ 评估文本（同函数同输入，单测锚定）
```

MySQL / Redis 同构：`mysqlExecuteSql` 评 `ensureSemicolon(sql)` 走 `evaluateMysqlCommandPolicy`；`redisExecuteCommand` 先过单行检查 + `isBlockingRedisCommand` 硬拒绝，再评 `command.trim()` 走 `evaluateRedisCommandPolicy`。

### 3.2 Bundle 布局

```text
dist/extension.js       ← src/extension.ts 全家（含 JumpServerAgentToolService、assetCommandTrust、
                          loadCommandPolicy）零 @at-series/command-policy 代码，零 WASM 引用
dist/mcpRuntime.js      ← src/mcp/mcpRuntime.ts（现状，不动）
dist/policy-runtime.js  ← src/policy-runtime/index.ts（新增，CJS + banner/define，
                          内联 @at-series/command-policy 的 shell/mysql/redis 入口）
dist/policy-assets/     ← copyPolicyAssets 产物：web-tree-sitter.wasm、tree-sitter-bash.wasm、
                          tree-sitter-python.wasm + 包内 NOTICE（Apache-2.0 合规）
```

`.vscodeignore` 不排除 `dist/**`，故 `policy-runtime.js` 与 `policy-assets/` 自动进 VSIX，无需改动。

### 3.3 policy-runtime 入口契约（`src/policy-runtime/index.ts`）

对齐 At-Terminal `createTerminalPolicyRuntime` 的形状，扩到三个域；evaluator 逐域 memoize，未用到的域不初始化解析器：

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PolicyAssetResolver, PolicyDecision, PolicyEvaluationInput } from '@at-series/command-policy';
import { createShellPolicyEvaluator, warmupShellPolicyEvaluator } from '@at-series/command-policy/shell';
import { createMysqlPolicyEvaluator } from '@at-series/command-policy/mysql';
import { createRedisPolicyEvaluator } from '@at-series/command-policy/redis';

export interface JumpServerPolicyRuntime {
  evaluateShell(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateMysql(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateRedis(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

export function createJumpServerPolicyRuntime(options: { assetDirectory: string }): JumpServerPolicyRuntime;
```

`assetResolver: (asset) => readFile(join(options.assetDirectory, asset.fileName))` 只给 shell 工厂（mysql / redis 工厂只收 `limits`，不需要 WASM）。工厂内 `void warmupShellPolicyEvaluator({ assetResolver }).catch(() => {})` 消掉首次 evaluate 的 ~18–20ms 冷启动；warmup 失败可忽略（evaluate 自身 fail closed）。

### 3.4 加载器与评估入口（`src/agent/loadCommandPolicy.ts`）

镜像 At-Terminal `loadRemoteCommandPolicy.ts`（去掉 `MCP_ENABLED`——JumpServer 无 base/mcp 双 variant）：本地结构化类型（不静态 import command-policy 的值）、`cached` Promise 单飞、`setCommandPolicyLoaderForTests` / `resetCommandPolicyForTests` 测试钩子、任何失败返回恒 `review` 的 unavailable runtime。

在 runtime 之上导出三个**插件形状**的评估入口——正是姊妹设计 §6.1 `ShellPolicyEvaluate` 占位类型的正式命名与实现（姊妹注释"命名以该设计为准"指向此处）：

```ts
export type CommandPolicyEvaluate = (input: { command: string; cwd?: string }) => Promise<{
  action: 'allow' | 'review' | 'deny';
  riskSummaries: readonly string[];   // evidence[].summary 压平，去空串，最多 3 条
  reasonCode: string;
}>;

export const evaluateShellCommandPolicy: CommandPolicyEvaluate;  // → runtime.evaluateShell
export const evaluateMysqlCommandPolicy: CommandPolicyEvaluate;  // → runtime.evaluateMysql
export const evaluateRedisCommandPolicy: CommandPolicyEvaluate;  // → runtime.evaluateRedis
```

入口内部：`command` → `sourceText` 原样透传（调用点已按 D7 给出精确文本）、懒加载 runtime、`try/catch` + action 合法性检查 fail closed 到 `{ action: 'review', reasonCode: 'policy.initialization_failed', riskSummaries: [] }`。

### 3.5 授权门迁移（Phase B，改姊妹的 `src/agent/assetCommandTrust.ts`）

姊妹计划落地的 `authorizeAssetCommand` 在 `policy` 档对 mysql / redis 用注入的 `isReadOnlySql` / `isReadOnlyRedisCommand`、对 ssh 用注入的 `evaluateShellPolicy`（service 缺省为 throw-stub，降级 = 弹窗）。Phase B 的改造：

1. service 缺省 `evaluateShellPolicy` 换成 `evaluateShellCommandPolicy`（姊妹计划预留的"一行改动"）。
2. 门签名把 `isReadOnlySql` / `isReadOnlyRedisCommand` 两个注入项**替换**为 `evaluateMysqlPolicy: CommandPolicyEvaluate` / `evaluateRedisPolicy: CommandPolicyEvaluate`；`policy` 档三个 kind 走同一条"`allow` 才 `autoApprove`，异常 / 非 allow 弹窗"路径。
3. 三个调用点把评估文本换成 D7 规定的精确文本（预览文本不变）。
4. 只读启发式改由 service 仅用于确认文案措辞（§4.4），不再进入门签名。

判定顺序（`full` → `none` → `policy`）、`shouldAutoApproveSftpWrite`、SFTP 分支均不动。

## 4. Tool → evaluator / trust 映射

### 4.1 评估文本（sourceText 契约）

| Tool | Evaluator（policy-runtime 内 import specifier） | 评估文本（`authorizeAssetCommand` 的 `command` 实参） | cwd | policy 之前的硬拒绝（保留，所有 trust） |
|------|------------------------------|-----------|-----|------------------------------------|
| `jumpserver_run_terminal_command` | `createShellPolicyEvaluator`（`@at-series/command-policy/shell`） | `normalizeShellCommand(command)` | `input.cwd` 单独传 | 空命令报错；非 ssh 资产报错 |
| `jumpserver_mysql_execute_sql` | `createMysqlPolicyEvaluator`（`@at-series/command-policy/mysql`） | `ensureSemicolon(sql)`（需从 `TerminalExecutors.ts` 导出） | 不传 | 空 SQL 报错；非 mysql 资产报错 |
| `jumpserver_redis_execute_command` | `createRedisPolicyEvaluator`（`@at-series/command-policy/redis`） | `command.trim()` | 不传 | 空命令 / 多行拒绝；**`isBlockingRedisCommand` 硬拒绝**；非 redis 资产报错 |
| `jumpserver_send_terminal_input` | 不评估 | — | — | 永远确认（所有 trust，含 `full`） |
| SFTP 写族（write_file / create / rename / delete / mkdir） | 不评估（文本策略不适用） | — | — | `shouldAutoApproveSftpWrite`，归姊妹 trust-mode 设计 |

Marker 脚手架（`printf '__JMS_CMD_START_…'`、`SELECT CONCAT('__JMS_SQL_START_…')`、`ECHO __JMS_REDIS_START_…`）是插件固定包裹、非 agent 可控输入，不进评估文本。

### 4.2 trust × decision → 确认行为（三条命令工具通用）

| trust | 加载 policy-runtime | `allow` | `review` | `deny` | 评估异常 / runtime 缺失 |
|-------|--------------------|---------|----------|--------|------------------------|
| `none`（默认） | 否 | —（一律确认） | — | — | —（一律确认） |
| `policy` | 是（懒加载 + 缓存） | 跳过确认 | 确认（附 riskSummaries + reasonCode） | 确认（强警示文案；域内已硬拒绝的除外） | 视同 `review` ⇒ 确认 |
| `full` | 否 | —（跳过确认） | — | — | —（跳过确认） |

聚合规则永远 `deny > review > allow`；插件只允许把库的判定收得更严（确认一个 `allow` 合法，放行一个 `review` 非法）。

### 4.3 现状 → 目标行为差异（需在 release note 明示）

| 场景 | 现状 | trust-mode 合入后（中间态） | Phase B 完成后（终态） |
|------|------|---------------------------|----------------------|
| SSH 命令 | 每次确认 | `none` 确认 / `policy` 恒弹窗（throw-stub 降级）/ `full` 跳过 | `policy` 按库判定 |
| MySQL 只读 SQL | `isReadOnlySql` 命中即免确认 | `none` 确认；`policy` 按只读启发式 | `policy` 由库判 `allow` 才免确认 |
| Redis 只读命令 | `isReadOnlyRedisCommand` 命中即免确认 | 同上 | 同上 |
| Redis blocking 命令 | 硬拒绝 | 硬拒绝（不变，先于 policy） | 硬拒绝（不变） |
| `send_terminal_input` | 每次确认 | 每次确认（不变） | 每次确认（不变） |

### 4.4 确认文案格式（riskSummaries 展示约定，姊妹设计遵循本节）

`formatCommandConfirmMessage`（`src/utils/commandPreview.ts`）扩展可选字段，输出形如：

```text
Run JumpServer SSH command on web-1 (10.0.0.5)?

rm -rf /tmp/x

Policy: review (policy.unknown_semantics)
- Writes to a file path
```

- `policyNote`：`review` → `Policy: review (<reasonCode>)`；`deny` → `Policy: DENY (<reasonCode>) — approve only if you are certain.`；`allow`（`full` / `none` 不评估）→ 无。
- `riskSummaries`：每条前缀 `- `，最多 3 条（评估入口已截断），全部是库保证 redacted 的固定措辞。
- 命令预览（`truncateCommandPreview`）照旧展示原始输入；policyNote / riskSummaries 里**不得**出现 sourceText、cwd、parser 错误。
- mysql / redis 的 action 前缀措辞沿用姊妹设计 §6.2：非只读 `'Run state-changing MySQL SQL'` / `'Run state-changing Redis command'`，只读但被 `none` / `review` 拦下 `'Run JumpServer MySQL SQL'` / `'Run JumpServer Redis command'`（措辞选择用降权后的 `isReadOnlySql` / `isReadOnlyRedisCommand`，见 D8）。

## 5. File map

| Path | Phase | Action |
|------|-------|--------|
| `package.json` | A | dependencies 加 `"@at-series/command-policy": "0.1.1"`（精确）；scripts 加 `copy:policy-assets`，`build` 串上 |
| `scripts/copy-policy-assets.mjs` | A | **Create**（从 At-Terminal 同名脚本移植：`copyPolicyAssets({ destinationDirectory: 'dist/policy-assets' })` + 复制包内 `NOTICE`） |
| `esbuild.config.mjs` | A | 加 `policy-runtime` context（CJS + banner + define）；watch / 一次性构建后复制资产 |
| `src/policy-runtime/index.ts` | A | **Create** `createJumpServerPolicyRuntime`（§3.3） |
| `src/agent/loadCommandPolicy.ts` | A | **Create** 懒加载器 + `evaluate{Shell,Mysql,Redis}CommandPolicy` + 测试钩子 + fail-closed（§3.4） |
| `test/agent/loadCommandPolicy.test.ts` | A | **Create** |
| `test/package.policyBundle.test.ts` | A | **Create** post-bundle 冒烟（§7.2） |
| `src/agent/TerminalExecutors.ts` | A | 导出 `ensureSemicolon`（现为私有）；`normalizeShellCommand` 已导出 |
| `test/agent/TerminalExecutors.test.ts` | A | 加"评估文本 ≡ 执行文本"锚定用例 |
| `src/agent/assetCommandTrust.ts` | B | **Modify**（姊妹计划创建）：mysql / redis 注入项换成 `CommandPolicyEvaluate`（§3.5） |
| `test/agent/assetCommandTrust.test.ts` | B | **Modify**（姊妹计划创建）：只读启发式映射用例改写为 policy 评估器用例 |
| `src/agent/JumpServerAgentToolService.ts` | B | 缺省评估器换 `evaluate*CommandPolicy`；三个调用点传精确文本；措辞选择接降权启发式 |
| `test/agent/JumpServerAgentToolService.test.ts` | B | 增量：evidence 展示、精确文本捕获、mysql/redis policy 分支 |
| `src/utils/commandPreview.ts` | B | `formatCommandConfirmMessage` 加 `policyNote` / `riskSummaries`（§4.4；若姊妹接线已按本格式实现则仅校验） |
| `test/utils/commandPreview.test.ts` | B | 增量格式用例 |
| `src/agent/SqlSafety.ts` / `src/agent/RedisSafety.ts` | B | 不删文件：`isReadOnlySql` / `isReadOnlyRedisCommand` 降权为措辞选择器（D8）；`isBlockingRedisCommand` 原样 |
| `src/mcp/toolCatalog.ts` | B | 三条命令工具 description 的有限信任措辞与最终策略语义对齐（姊妹计划已加三档说明） |

不改 mcp-hub、不改 command-policy、不新增 IDE 配置项（trust UI 归姊妹设计）。

## 6. esbuild 配方（强制项）

`esbuild.config.mjs` 新增 context（照抄本节，`banner` + `define` 缺一不可——漏配没有构建错误、没有运行时异常，只有 `python3 -c` 全部静默 fail-closed 成 `review`）：

```js
esbuild.context({
  ...common,
  entryPoints: ['src/policy-runtime/index.ts'],
  outfile: 'dist/policy-runtime.js',
  platform: 'node',
  target: NODE_TARGET,          // 'node18'
  format: 'cjs',
  banner: {
    js: 'var __policyRuntimeModuleUrl = require("node:url").pathToFileURL(__filename).href;'
  },
  define: {
    'import.meta.url': '__policyRuntimeModuleUrl'
  }
})
```

构建（watch 与一次性均是）末尾追加：

```js
const { copyPolicyRuntimeAssets } = await import('./scripts/copy-policy-assets.mjs');
await copyPolicyRuntimeAssets();
```

不做 README §3 的 sibling-external 字节级拆分（`*/mysql.js` external 方案）：JumpServer 本来就要 mysql / redis 分析器，拆开只多出文件管理成本；执行级懒加载已由库保证（无内嵌载荷的 `uptime` 不会初始化 SQL 解析器）。体积上限由 §7.2 预算测试看护。

## 7. Test strategy

### 7.1 单元（vitest，无网络、无 dist 依赖）

- `loadCommandPolicy.test.ts`（Phase A）：并发调用单飞缓存；测试注入钩子；require 失败 ⇒ unavailable runtime（恒 `review`）；`evaluate*CommandPolicy` 把 `evidence[].summary` 压平成 riskSummaries、去空串、截 3 条；action 非法 ⇒ `review` + `policy.initialization_failed`。
- `TerminalExecutors.test.ts` 增量（Phase A）：`wrapShellCommand(command, cwd, id)` 内嵌载荷 ≡ `quotePosix(normalizeShellCommand(command))`；`ensureSemicolon` 导出后行为不变——锚定 D7"评估文本 ≡ 执行文本"。
- `assetCommandTrust.test.ts` 改写（Phase B）：`policy`+mysql/redis 的 `allow`→`autoApprove:true`、`review`/`deny`/抛错→`false` + `reasonCode` 透传（替换姊妹计划的只读启发式映射用例）；`none`/`full` 不调用任何评估器（spy 零调用）保持不变。
- `JumpServerAgentToolService.test.ts` 增量（Phase B；姊妹计划已覆盖 none/full/policy 三态与 send_input / SFTP，不重复）：评估入参捕获——ssh 收到 `normalizeShellCommand(command)` 与单独的 `cwd`、mysql 收到 `ensureSemicolon(sql)`；确认文案含 `Policy: review (…)` 与 `- <summary>` 行；`deny` 文案含强警示；Redis blocking 在 `full` 下仍硬拒绝且评估器零调用。

### 7.2 Post-bundle 冒烟（`test/package.policyBundle.test.ts`，Phase A；模式对齐 At-Terminal `test/package.baseBundle.test.ts`）

构建后 `createRequire` 加载真实 `dist/policy-runtime.js` + `dist/policy-assets`，断言：

1. `evaluateShell({ sourceText: 'uptime' })` → `allow`；
2. `evaluateShell({ sourceText: 'python3 -c "print(1)"' })` → `allow`（**import.meta.url 哨兵**：banner/define 漏配时此处变 `review`）；
3. `rm -rf /tmp/app` → 非 `allow`；`SELECT 1;` → `allow`、`DROP TABLE t;` → 非 `allow`（mysql）；`GET mykey` → `allow`、`FLUSHALL` → 非 `allow`、`BLPOP q 0` → `deny`（redis）；
4. `dist/extension.js` 不含 `createShellPolicyEvaluator` / `tree-sitter-bash` / `@at-series/command-policy` / `createJumpServerPolicyRuntime` 字面量；
5. 体积预算：`dist/policy-assets/*.wasm` 合计 >0 且 ≤ 2.5MB；`policy-runtime.js` + WASM gzip 合计 ≤ 600KB（At-Terminal 同构 bundle 实测在 500KB 预算内，JumpServer 只多两个薄工厂导出）。

### 7.3 手工冒烟（Phase B 后，配合 trust-mode UI）

1. `npm run build` → `dist/policy-runtime.js`、`dist/policy-assets/{web-tree-sitter,tree-sitter-bash,tree-sitter-python}.wasm` 存在；
2. F5 扩展宿主，资产 trust 设为 `policy`（姊妹设计的 `jumpserverManager.setAssetTrust`），`jumpserver_run_terminal_command` 跑 `uptime` 不弹框、`rm /tmp/x` 弹框且附 policy 摘要；
3. trust `none` 资产跑 `SELECT 1` 弹框；trust `full` 资产跑任意命令不弹框但 `send_terminal_input` 仍弹框。

## 8. Out of scope

- trust 的存储 schema、`resolveAssetTrust`/`setAssetTrust`、资产树 UI、`setAssetTrust` 命令、迁移与默认值——姊妹设计
- `authorizeAssetCommand` / `shouldAutoApproveSftpWrite` 骨架与 service 首轮接线——姊妹计划（本设计只做 Phase B 注入替换）
- SFTP 写族确认与 trust 的映射——姊妹设计
- 修改 mcp-hub 源码；修改 command-policy 源码或发新版本（发现 gap 先举证再议）
- base/mcp 双 variant 拆分（JumpServer 整包即 MCP 能力，无 agentless variant）
- `send_terminal_input` 的任何"智能放行"
- audit log、决策遥测
- 用 `copyPolicyAssets({ include })` 裁剪 python WASM（冒烟要求 `python3 -c` 为 `allow`，不可裁）

## 9. Risks / non-goals

| Risk | Mitigation |
|------|------------|
| banner/define 漏配 ⇒ `python3 -c` 全部静默 review，无任何报错 | §7.2 冒烟第 2 条常驻 CI；esbuild 配方在 §6 整段给出，禁止改写 |
| 评估文本与执行文本漂移（有人改 `wrapShellCommand` / `ensureSemicolon` 忘了同步） | 评估与执行共用同一导出函数；`TerminalExecutors.test.ts` 锚定字节相等 |
| 与姊妹计划的接缝漂移（门签名、评估入口命名、文案格式各改各的） | 单一来源划界：trust 类型 / 门骨架 / 接线归姊妹，评估入口命名（`CommandPolicyEvaluate`、`evaluate*CommandPolicy`）与文案格式（§4.4）归本设计；两边都已互引对方章节 |
| 默认 `none` 撤销只读免确认 ⇒ 确认疲劳 | 有意的产品收紧（JumpServer 此前无 trust 模型，共享 `allow` 不得跳确认）；缓解 = 姊妹设计的 per-asset `policy`/`full`；release note 写明 |
| 中间态（trust-mode 已合、Phase B 未合）ssh 在 `policy` 档恒弹窗 | 姊妹计划已把该降级定义为预期行为（throw-stub ⇒ 弹窗）；Phase B 只替换缺省实现，测试全保留 |
| `deny` 仍可被用户确认放行 | 符合"插件只能更严"契约；confirm 文案对 `deny` 用强警示；Redis blocking 仍是先行硬拒绝 |
| vitest 环境无 dist bundle ⇒ loader 走不到真实 runtime | 单测经 `setCommandPolicyLoaderForTests` 注入；真实 bundle 由 §7.2 专测覆盖 |
| 双评估（SSH 文本再喂 mysql evaluator）造成误 `allow`/误 `review` | D9 明令禁止；shell 分析器已内嵌静态载荷再入分析 |
| WASM 资产缺失 / 损坏 ⇒ shell 全 review（`policy.initialization_failed`） | 安全但无用；§7.2 冒烟第 1 条防回归；`copy:policy-assets` 进 `build` 脚本链 |
| mysql 解析器体积（单文件 bundle ~1.29MB 未压缩） | 独立 bundle 不进 `extension.js`；gzip 预算测试看护；不做 sibling external 拆分（§6） |
| 0.1.1 覆盖不了某条真实命令形态 | fail closed 到 `review`（确认，不比现状差）；确证 gap 才考虑升级 / 发版（D13） |

---

## Spec self-review

1. **Placeholders:** 无。版本（0.1.1）、工厂名、导出名、esbuild 配方、冒烟断言全部对照 command-policy `docs/api.md` / `README.md` 与 At-Terminal 实现核实；与姊妹设计的接缝（`AssetCommandTrust`、`resolveAssetTrust`、`authorizeAssetCommand` 签名、`CommandPolicyEvaluate` 占位、文案措辞规则）逐条对照其 §4–§6 落笔。
2. **Consistency:** trust 语义（asset 级、默认 none、send_input 永确认、SFTP 归属）与姊妹设计共享同一份产品决策；D14 的三步合入顺序与姊妹计划的 Branch/依赖说明互相印证（姊妹从本计划分支或其合并后主线创建，ssh 缺省 throw-stub 等待 Phase B 替换）。
3. **Scope:** 本设计只交付引擎（bundle / loader / 评估入口 / 冒烟）与 Phase B 注入替换；门骨架、trust 存储、UI 明确划给姊妹，无双写。
4. **Ambiguity:** 已消除三处易错点——评估文本用哪一份（D7：与 executor 同函数）、`none` 下 MySQL/Redis 只读是否仍免确认（D3/D8：不再免确认，写入 §4.3 对照表）、只读启发式删还是留（D8：降权为措辞选择器，姊妹措辞规则依赖它，不删）。
