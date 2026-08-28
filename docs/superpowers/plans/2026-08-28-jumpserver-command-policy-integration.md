# JumpServer Command Policy 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@at-series/command-policy@0.1.1` 接入 AT JumpServer Terminal。分两个阶段：**Phase A**（Task 1–5，独立合入、零行为变化）交付 `dist/policy-runtime.js` bundle、WASM 资产、懒加载器与三个插件形状的评估入口 `evaluate{Shell,Mysql,Redis}CommandPolicy`；**Phase B**（Task 6–9，前置 = trust-mode 计划的授权门与 service 接线已合入）把 `assetCommandTrust.ts` 里的注入分析器换成真 policy 评估器：SSH 走 `createShellPolicyEvaluator`，MySQL / Redis 从只读启发式迁移到 `createMysqlPolicyEvaluator` / `createRedisPolicyEvaluator`，`allow` 免确认、`review`/`deny` 弹窗、fail closed。

**Architecture:** 授权门 `authorizeAssetCommand`（`src/agent/assetCommandTrust.ts`，**姊妹计划创建**）按 trust 分流，评估器以函数注入；本计划提供注入的实现——`src/agent/loadCommandPolicy.ts` 懒 require `dist/policy-runtime.js`（运行时 `join(__dirname, 'policy-runtime.js')`，镜像现有 `mcpRuntime.js` 拆分），`src/policy-runtime/index.ts` 用 esbuild 单独打成 CJS（`banner`+`define 'import.meta.url'` 强制），WASM 经 `copyPolicyAssets` 落到 `dist/policy-assets/`、运行时经 `assetResolver` 读取。评估文本与执行文本共用同一导出函数（`normalizeShellCommand` / `ensureSemicolon` / `trim`），决策后不改写。

**Tech Stack:** 现有 JumpServer VS Code 扩展（esbuild、vitest、zod）+ `@at-series/command-policy@0.1.1`。结构模板：At-Terminal 的 `src/policy-runtime/index.ts`、`src/agent/loadRemoteCommandPolicy.ts`、`src/agent/remoteCommandAuthorization.ts`、`scripts/copy-policy-assets.mjs`、`test/package.baseBundle.test.ts`。

**Hard constraints:**

1. `"@at-series/command-policy": "0.1.1"` **精确锁定**——不用 `^`/`~`，不用 `file:`。
2. **不修改** mcp-hub 与 command-policy 源码；不发 command-policy 新版本（发现 gap 先停下举证）。
3. trust 存储 / UI / `resolveAssetTrust` / 授权门骨架 / service 首轮接线归姊妹计划 `docs/superpowers/plans/2026-08-28-jumpserver-asset-trust-mode.md`；本计划 Phase B 只做注入替换与门签名扩展，不重建这些模块。
4. `jumpserver_send_terminal_input` 在所有 trust 级别（含 `full`）永远确认，不评估——本计划不碰它。
5. esbuild `banner` + `define 'import.meta.url'` 不可省略（漏配无任何报错，`python3 -c` 全部静默 review）；post-bundle 冒烟必须包含 `uptime`→`allow` 与 `python3 -c "print(1)"`→`allow` 两条哨兵断言。
6. 评估**将要执行的那份文本**：SSH `normalizeShellCommand(command)`（`cwd` 单独传）、MySQL `ensureSemicolon(sql)`、Redis `command.trim()`；SSH 只走 shell evaluator，禁止再叠 mysql evaluator 双评估。
7. `isBlockingRedisCommand` 保留并在 trust 判定 / policy 评估**之前**硬拒绝；`isReadOnlySql` / `isReadOnlyRedisCommand` 降权为确认文案措辞选择器（姊妹设计 §6.2 措辞规则依赖），不删除。

**Spec:** `docs/superpowers/specs/2026-08-28-jumpserver-command-policy-integration-design.md`（trust 语义与门骨架另见 `docs/superpowers/specs/2026-08-28-jumpserver-asset-trust-mode-design.md`）

**Out of scope:** trust 存储/UI/迁移、`shouldAutoApproveSftpWrite` 与 SFTP 确认映射（均归姊妹计划）、audit log、base/mcp variant 拆分、`copyPolicyAssets({ include })` 裁剪 WASM。

**合入顺序（与姊妹计划互锁）:** Phase A（本计划）→ trust-mode 计划（其 ssh 缺省评估器为 throw-stub、mysql/redis 暂用只读启发式，降级 = 弹窗）→ Phase B（本计划）。姊妹计划的 Branch 说明已声明从本计划分支或其合并后主线创建。Phase B 合入前的中间态行为安全（`policy` 档 ssh 恒弹窗）。Release note 需写明默认 `none` 的确认收紧，建议与 trust-mode 同一 release 发布。

---

## File map

| Path | Phase | Action |
|------|-------|--------|
| `package.json` | A | dependencies 加 `"@at-series/command-policy": "0.1.1"`；scripts 加 `copy:policy-assets` 并串进 `build`（Task 1–2） |
| `scripts/copy-policy-assets.mjs` | A | **Create**（Task 2） |
| `esbuild.config.mjs` | A | 加 policy-runtime context + 构建后复制资产（Task 2） |
| `src/policy-runtime/index.ts` | A | **Create** `createJumpServerPolicyRuntime`（Task 2） |
| `test/package.policyBundle.test.ts` | A | **Create** post-bundle 冒烟（Task 3） |
| `src/agent/loadCommandPolicy.ts` | A | **Create** 懒加载器 + `evaluate*CommandPolicy` + 测试钩子（Task 4） |
| `test/agent/loadCommandPolicy.test.ts` | A | **Create**（Task 4） |
| `src/agent/TerminalExecutors.ts` | A | 导出 `ensureSemicolon`（Task 5） |
| `test/agent/TerminalExecutors.test.ts` | A | 加评估文本≡执行文本锚定用例（Task 5） |
| `src/agent/assetCommandTrust.ts` | B | **Modify**（姊妹创建）：mysql/redis 注入项换 `CommandPolicyEvaluate`（Task 6） |
| `test/agent/assetCommandTrust.test.ts` | B | **Modify**（姊妹创建）：启发式映射用例改写（Task 6） |
| `src/utils/commandPreview.ts` | B | `formatCommandConfirmMessage` 加 `policyNote` / `riskSummaries`（Task 7） |
| `test/utils/commandPreview.test.ts` | B | 格式用例（Task 7） |
| `src/agent/JumpServerAgentToolService.ts` | B | 缺省评估器换真实现；调用点传精确文本；措辞接降权启发式（Task 7） |
| `test/agent/JumpServerAgentToolService.test.ts` | B | 增量用例（Task 7） |
| `src/mcp/toolCatalog.ts` | B | 有限信任措辞与最终策略语义对齐（Task 8） |

---

## Phase A — 引擎与评估入口（独立合入，零行为变化）

### Task 1: 精确锁定 `@at-series/command-policy@0.1.1`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加依赖（精确版本）**

`package.json` `dependencies`：

```json
"@at-series/command-policy": "0.1.1"
```

注意没有 `^`。这是安全边界，锁死到 main 分支当前发布版。

- [ ] **Step 2: 安装并验证入口可解析**

```bash
npm install
node -e "console.log(require.resolve('@at-series/command-policy'))"
node -e "console.log(require.resolve('@at-series/command-policy/shell'))"
node -e "console.log(require.resolve('@at-series/command-policy/mysql'))"
node -e "console.log(require.resolve('@at-series/command-policy/redis'))"
node -e "console.log(require.resolve('@at-series/command-policy/build'))"
node -e "console.log(require('@at-series/command-policy/package.json').version)"
```

期望：全部落在 `node_modules/@at-series/command-policy` 下，版本打印 `0.1.1`。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: pin @at-series/command-policy 0.1.1"
```

---

### Task 2: policy-runtime bundle + WASM 资产复制

**Files:**
- Create: `src/policy-runtime/index.ts`
- Create: `scripts/copy-policy-assets.mjs`
- Modify: `esbuild.config.mjs`
- Modify: `package.json`（scripts）

- [ ] **Step 1: 写 `src/policy-runtime/index.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PolicyAssetResolver,
  PolicyDecision,
  PolicyEvaluationInput,
  PolicyEvaluator
} from '@at-series/command-policy';
import { createShellPolicyEvaluator, warmupShellPolicyEvaluator } from '@at-series/command-policy/shell';
import { createMysqlPolicyEvaluator } from '@at-series/command-policy/mysql';
import { createRedisPolicyEvaluator } from '@at-series/command-policy/redis';

export interface JumpServerPolicyRuntimeOptions {
  readonly assetDirectory: string;
}

export interface JumpServerPolicyRuntime {
  evaluateShell(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateMysql(input: PolicyEvaluationInput): Promise<PolicyDecision>;
  evaluateRedis(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

export function createJumpServerPolicyRuntime(
  options: JumpServerPolicyRuntimeOptions
): JumpServerPolicyRuntime {
  const assetResolver: PolicyAssetResolver = (asset) =>
    readFile(join(options.assetDirectory, asset.fileName));
  // 首次 evaluate 的 Tree-sitter 冷启动约 18–20ms；warmup 失败可忽略，
  // evaluate 自身 fail closed 到 review。
  void warmupShellPolicyEvaluator({ assetResolver }).catch(() => {});
  let shell: PolicyEvaluator | undefined;
  let mysql: PolicyEvaluator | undefined;
  let redis: PolicyEvaluator | undefined;
  return {
    evaluateShell: (input) => (shell ??= createShellPolicyEvaluator({ assetResolver })).evaluate(input),
    evaluateMysql: (input) => (mysql ??= createMysqlPolicyEvaluator()).evaluate(input),
    evaluateRedis: (input) => (redis ??= createRedisPolicyEvaluator()).evaluate(input)
  };
}
```

mysql / redis 工厂只收 `limits`，不传 `assetResolver`（SQL/Redis 分析不用 WASM）。SSH 文本只喂 `evaluateShell`——静态 `python3 -c` / `mysql -e` 载荷由 shell 分析器内嵌再入分析，不得在插件侧叠加 mysql evaluator。

- [ ] **Step 2: 写 `scripts/copy-policy-assets.mjs`**（对齐 At-Terminal 同名脚本）

```js
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyPolicyAssets } from '@at-series/command-policy/build';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destinationDirectory = join(root, 'dist', 'policy-assets');

export async function copyPolicyRuntimeAssets() {
  // 不传 include：三个 WASM 全复制。裁掉 tree-sitter-python 会让
  // python3 -c 冒烟哨兵从 allow 变 review。
  await copyPolicyAssets({ destinationDirectory });
  const noticePath = join(dirname(require.resolve('@at-series/command-policy/package.json')), 'NOTICE');
  await cp(noticePath, join(destinationDirectory, 'NOTICE'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyPolicyRuntimeAssets();
}
```

- [ ] **Step 3: `esbuild.config.mjs` 加 policy-runtime context**

在 `contextConfigs` 数组追加（`banner` + `define` **一个都不能少**——漏配没有构建错误、没有运行时异常，只有 `python3 -c` 全部静默 fail-closed 成 review）：

```js
esbuild.context({
  ...common,
  entryPoints: ['src/policy-runtime/index.ts'],
  outfile: 'dist/policy-runtime.js',
  platform: 'node',
  target: NODE_TARGET,
  format: 'cjs',
  banner: {
    js: 'var __policyRuntimeModuleUrl = require("node:url").pathToFileURL(__filename).href;'
  },
  define: {
    'import.meta.url': '__policyRuntimeModuleUrl'
  }
})
```

watch 分支与一次性分支末尾都追加资产复制：

```js
const { copyPolicyRuntimeAssets } = await import('./scripts/copy-policy-assets.mjs');
await copyPolicyRuntimeAssets();
```

不做 README §3 的 sibling-external 字节级拆分：JumpServer 本来就需要 mysql / redis 分析器，执行级懒加载已由库保证。

- [ ] **Step 4: `package.json` scripts**

```json
"copy:policy-assets": "node scripts/copy-policy-assets.mjs",
"build": "npm run sync:l10n && node esbuild.config.mjs && npm run copy:hub && npm run copy:policy-assets"
```

- [ ] **Step 5: 构建验证**

```bash
npm run build
ls dist/policy-runtime.js
ls dist/policy-assets
```

期望：`dist/policy-assets/` 含 `web-tree-sitter.wasm`、`tree-sitter-bash.wasm`、`tree-sitter-python.wasm`、`NOTICE`。`.vscodeignore` 不排除 `dist/**`，两者自动进 VSIX，无需改动。

- [ ] **Step 6: Commit**

```bash
git add src/policy-runtime scripts/copy-policy-assets.mjs esbuild.config.mjs package.json
git commit -m "build: bundle command-policy runtime and WASM assets separately"
```

---

### Task 3: Post-bundle 冒烟测试（import.meta.url 哨兵）

**Files:**
- Create: `test/package.policyBundle.test.ts`

- [ ] **Step 1: 写测试**（模式对齐 At-Terminal `test/package.baseBundle.test.ts`：对真实构建产物断言，字符串字面量而非标识符——minify 会改名）

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JumpServerPolicyRuntime } from '../src/policy-runtime/index';

const require = createRequire(__filename);

let extensionBundle = '';
let runtime: JumpServerPolicyRuntime;
let wasmBytes = 0;
let gzipBytes = 0;

beforeAll(() => {
  execFileSync(process.execPath, ['esbuild.config.mjs'], { stdio: 'pipe' });
  extensionBundle = readFileSync('dist/extension.js', 'utf8');
  const loaded = require(join(process.cwd(), 'dist/policy-runtime.js')) as {
    createJumpServerPolicyRuntime(options: { assetDirectory: string }): JumpServerPolicyRuntime;
  };
  runtime = loaded.createJumpServerPolicyRuntime({
    assetDirectory: join(process.cwd(), 'dist/policy-assets')
  });
  const wasmFiles = readdirSync('dist/policy-assets').filter((name) => name.endsWith('.wasm'));
  wasmBytes = wasmFiles.reduce(
    (total, name) => total + statSync(join('dist/policy-assets', name)).size,
    0
  );
  gzipBytes = gzipSync(readFileSync('dist/policy-runtime.js')).length
    + wasmFiles.reduce(
      (total, name) => total + gzipSync(readFileSync(join('dist/policy-assets', name))).length,
      0
    );
}, 180_000);

describe('policy runtime bundle', () => {
  it('allows a plain observer command', async () => {
    expect((await runtime.evaluateShell({ sourceText: 'uptime' })).action).toBe('allow');
  });

  it('allows an embedded python read (guards the import.meta.url define)', async () => {
    // review 意味着 esbuild banner/define 被删或改坏了 —— 见 spec §6。
    expect(
      (await runtime.evaluateShell({ sourceText: 'python3 -c "print(1)"' })).action
    ).toBe('allow');
  });

  it('keeps writes and controls out of auto-allow', async () => {
    expect((await runtime.evaluateShell({ sourceText: 'rm -rf /tmp/app' })).action).not.toBe('allow');
    expect((await runtime.evaluateMysql({ sourceText: 'SELECT 1;' })).action).toBe('allow');
    expect((await runtime.evaluateMysql({ sourceText: 'DROP TABLE t;' })).action).not.toBe('allow');
    expect((await runtime.evaluateRedis({ sourceText: 'GET mykey' })).action).toBe('allow');
    expect((await runtime.evaluateRedis({ sourceText: 'FLUSHALL' })).action).not.toBe('allow');
    expect((await runtime.evaluateRedis({ sourceText: 'BLPOP q 0' })).action).toBe('deny');
  });

  it('keeps policy code out of dist/extension.js', () => {
    expect(extensionBundle).not.toContain('createShellPolicyEvaluator');
    expect(extensionBundle).not.toContain('createJumpServerPolicyRuntime');
    expect(extensionBundle).not.toContain('tree-sitter-bash');
    expect(extensionBundle).not.toContain('@at-series/command-policy');
  });

  it('ships license notice next to the wasm assets', () => {
    // esbuild.config.mjs 一次性分支内联调用 copyPolicyRuntimeAssets（Task 2 Step 3），
    // 所以 beforeAll 只跑 esbuild.config.mjs 也应产出 NOTICE。
    expect(existsSync('dist/policy-assets/NOTICE')).toBe(true);
  });

  it('stays inside the size budget', () => {
    expect(wasmBytes).toBeGreaterThan(0);
    expect(wasmBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    expect(gzipBytes).toBeGreaterThan(0);
    expect(gzipBytes).toBeLessThanOrEqual(600 * 1024);
  });
});
```

- [ ] **Step 2: 跑通**

```bash
npx vitest run test/package.policyBundle.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add test/package.policyBundle.test.ts
git commit -m "test: post-bundle smoke for policy runtime incl. import.meta.url sentinel"
```

---

### Task 4: 懒加载器 + 插件形状评估入口 `loadCommandPolicy`

**Files:**
- Create: `src/agent/loadCommandPolicy.ts`
- Create: `test/agent/loadCommandPolicy.test.ts`

`evaluateShellCommandPolicy` 等三个导出就是姊妹设计 §6.1 `ShellPolicyEvaluate` 占位类型的正式实现（姊妹注释"命名以该设计为准"指向本任务）。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateMysqlCommandPolicy,
  evaluateShellCommandPolicy,
  loadCommandPolicyRuntime,
  resetCommandPolicyForTests,
  setCommandPolicyLoaderForTests
} from '../../src/agent/loadCommandPolicy';

afterEach(() => resetCommandPolicyForTests());

const decision = (overrides: object = {}) => ({
  action: 'allow' as const,
  reasonCode: 'x',
  evidence: [],
  ...overrides
});

const runtimeWith = (result: unknown) => ({
  evaluateShell: vi.fn().mockResolvedValue(result),
  evaluateMysql: vi.fn().mockResolvedValue(result),
  evaluateRedis: vi.fn().mockResolvedValue(result)
});

describe('loadCommandPolicyRuntime', () => {
  it('caches the loader across calls', async () => {
    const loader = vi.fn(() => runtimeWith(decision()));
    setCommandPolicyLoaderForTests(loader);
    await loadCommandPolicyRuntime();
    await loadCommandPolicyRuntime();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fails closed to review when the loader throws', async () => {
    setCommandPolicyLoaderForTests(() => {
      throw new Error('boom');
    });
    const runtime = await loadCommandPolicyRuntime();
    const result = await runtime.evaluateShell({ sourceText: 'uptime' });
    expect(result.action).toBe('review');
    expect(result.reasonCode).toBe('policy.initialization_failed');
  });

  it('fails closed when the bundled runtime is missing (vitest has no dist/)', async () => {
    const runtime = await loadCommandPolicyRuntime();
    expect((await runtime.evaluateRedis({ sourceText: 'GET k' })).action).toBe('review');
  });
});

describe('evaluate*CommandPolicy adapters', () => {
  it('maps command to sourceText and flattens evidence into riskSummaries', async () => {
    const runtime = runtimeWith(decision({
      action: 'review',
      reasonCode: 'policy.unknown_semantics',
      evidence: [{ summary: 'a' }, { summary: '' }, { summary: 'b' }, { summary: 'c' }, { summary: 'd' }]
    }));
    setCommandPolicyLoaderForTests(() => runtime);
    const verdict = await evaluateShellCommandPolicy({ command: 'tee /etc/x', cwd: '/srv' });
    expect(runtime.evaluateShell).toHaveBeenCalledWith({ sourceText: 'tee /etc/x', cwd: '/srv' });
    expect(verdict).toEqual({
      action: 'review',
      reasonCode: 'policy.unknown_semantics',
      riskSummaries: ['a', 'b', 'c']   // 去空串、截 3 条
    });
  });

  it('fails closed on malformed actions', async () => {
    setCommandPolicyLoaderForTests(() => runtimeWith(decision({ action: 'yolo' })));
    const verdict = await evaluateMysqlCommandPolicy({ command: 'SELECT 1;' });
    expect(verdict.action).toBe('review');
    expect(verdict.reasonCode).toBe('policy.initialization_failed');
  });
});
```

- [ ] **Step 2: 实现**（结构模板：At-Terminal `src/agent/loadRemoteCommandPolicy.ts`；去掉 `MCP_ENABLED` 检查——JumpServer 无 base/mcp variant。本地结构化类型，**不** import `@at-series/command-policy` 的值，保持 `dist/extension.js` 干净可 grep）

```ts
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface CommandPolicyDecision {
  readonly action: 'allow' | 'review' | 'deny';
  readonly reasonCode: string;
  readonly evidence: readonly { readonly summary: string }[];
}

export interface CommandPolicyRuntime {
  evaluateShell(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
  evaluateMysql(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
  evaluateRedis(input: { sourceText: string; cwd?: string }): Promise<CommandPolicyDecision>;
}

/** 姊妹设计 §6.1 ShellPolicyEvaluate 的正式形状：三个域共用。 */
export type CommandPolicyEvaluate = (input: { command: string; cwd?: string }) => Promise<{
  action: 'allow' | 'review' | 'deny';
  riskSummaries: readonly string[];
  reasonCode: string;
}>;

const MAX_RISK_SUMMARIES = 3;

const INITIALIZATION_FAILED: CommandPolicyDecision = Object.freeze({
  action: 'review',
  reasonCode: 'policy.initialization_failed',
  evidence: Object.freeze([])
});

function createUnavailableRuntime(): CommandPolicyRuntime {
  const evaluate = async () => INITIALIZATION_FAILED;
  return { evaluateShell: evaluate, evaluateMysql: evaluate, evaluateRedis: evaluate };
}

type PolicyRuntimeLoader = () => CommandPolicyRuntime | Promise<CommandPolicyRuntime>;

let testLoader: PolicyRuntimeLoader | undefined;
let cached: Promise<CommandPolicyRuntime> | undefined;

export function setCommandPolicyLoaderForTests(loader: PolicyRuntimeLoader | undefined): void {
  testLoader = loader;
  cached = undefined;
}

export function resetCommandPolicyForTests(): void {
  testLoader = undefined;
  cached = undefined;
}

function loadBundledPolicyRuntime(): CommandPolicyRuntime {
  try {
    // 打进 dist/extension.js 后 __dirname === dist/，与 dist/policy-runtime.js、
    // dist/policy-assets 同级；非字面量路径 esbuild 不会内联。
    const require = createRequire(__filename);
    const runtime = require(join(__dirname, 'policy-runtime.js')) as {
      createJumpServerPolicyRuntime?: (options: { assetDirectory: string }) => CommandPolicyRuntime;
    };
    if (typeof runtime.createJumpServerPolicyRuntime !== 'function') {
      return createUnavailableRuntime();
    }
    return runtime.createJumpServerPolicyRuntime({
      assetDirectory: join(__dirname, 'policy-assets')
    });
  } catch {
    return createUnavailableRuntime();
  }
}

export async function loadCommandPolicyRuntime(): Promise<CommandPolicyRuntime> {
  cached ??= (async () => {
    if (testLoader) {
      return await testLoader();
    }
    return loadBundledPolicyRuntime();
  })();
  try {
    return await cached;
  } catch {
    cached = undefined;
    return createUnavailableRuntime();
  }
}

function isPolicyAction(value: unknown): value is CommandPolicyDecision['action'] {
  return value === 'allow' || value === 'review' || value === 'deny';
}

function toVerdict(decision: CommandPolicyDecision): Awaited<ReturnType<CommandPolicyEvaluate>> {
  if (!isPolicyAction(decision.action)) {
    return { action: 'review', reasonCode: 'policy.initialization_failed', riskSummaries: [] };
  }
  return {
    action: decision.action,
    reasonCode: decision.reasonCode,
    riskSummaries: decision.evidence
      .map((item) => item.summary)
      .filter((summary) => summary.length > 0)
      .slice(0, MAX_RISK_SUMMARIES)
  };
}

function createEvaluate(
  pick: (runtime: CommandPolicyRuntime) => CommandPolicyRuntime['evaluateShell']
): CommandPolicyEvaluate {
  return async (input) => {
    try {
      const runtime = await loadCommandPolicyRuntime();
      return toVerdict(await pick(runtime)({ sourceText: input.command, cwd: input.cwd }));
    } catch {
      return { action: 'review', reasonCode: 'policy.initialization_failed', riskSummaries: [] };
    }
  };
}

export const evaluateShellCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateShell.bind(r));
export const evaluateMysqlCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateMysql.bind(r));
export const evaluateRedisCommandPolicy: CommandPolicyEvaluate = createEvaluate((r) => r.evaluateRedis.bind(r));
```

- [ ] **Step 3: Pass + commit**

```bash
npx vitest run test/agent/loadCommandPolicy.test.ts
git add src/agent/loadCommandPolicy.ts test/agent/loadCommandPolicy.test.ts
git commit -m "feat: lazy fail-closed loader and plugin-shape policy evaluate entries"
```

---

### Task 5: 评估文本 ≡ 执行文本（导出 + 锚定测试）

**Files:**
- Modify: `src/agent/TerminalExecutors.ts`
- Modify: `test/agent/TerminalExecutors.test.ts`

- [ ] **Step 1: 导出 `ensureSemicolon`**

`TerminalExecutors.ts` 中现为私有的：

```ts
export function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
```

（`normalizeShellCommand` 已导出，无需改动。）

- [ ] **Step 2: 加锚定用例**——防止有人改 `wrapShellCommand` / executor 正文后评估文本与执行文本漂移：

```ts
it('embeds exactly the normalized command that policy evaluation sees', () => {
  const command = '  # Purpose: check\n uptime \n df -h ';
  const normalized = normalizeShellCommand(command);
  const wrapped = wrapShellCommand(command, undefined, 'testid');
  expect(wrapped).toContain(`eval '${normalized.replaceAll("'", "'\\''")}'`);
});

it('mysql executor sends exactly ensureSemicolon(sql) between the markers', () => {
  // 复用现有 executor 测试基建：捕获 write() 载荷，断言第二行 === ensureSemicolon(sql)
});
```

- [ ] **Step 3: Pass + commit**

```bash
npx vitest run test/agent/TerminalExecutors.test.ts
git add src/agent/TerminalExecutors.ts test/agent/TerminalExecutors.test.ts
git commit -m "feat: export mysql text normalization and anchor evaluated==executed text"
```

---

## Phase B — 授权门注入替换（前置：trust-mode 计划 Task 3–4 已合入）

开工前确认（缺一即停，先合姊妹计划）：

```bash
ls src/agent/assetCommandTrust.ts
rg -n "authorizeAssetCommand" src/agent/JumpServerAgentToolService.ts
rg -n "resolveAssetTrust" src/config/JumpServerConfigManager.ts
```

### Task 6: `authorizeAssetCommand` 的 mysql / redis 分支迁到 policy 评估器

**Files:**
- Modify: `src/agent/assetCommandTrust.ts`（姊妹创建）
- Modify: `test/agent/assetCommandTrust.test.ts`（姊妹创建）

- [ ] **Step 1: 改签名**——把 `isReadOnlySql` / `isReadOnlyRedisCommand` 两个注入项**替换**为与 ssh 同构的评估器注入：

```ts
import type { CommandPolicyEvaluate } from './loadCommandPolicy';

export async function authorizeAssetCommand(options: {
  trust: AssetCommandTrust;
  kind: 'ssh' | 'mysql' | 'redis';
  /** 将要执行的精确文本（spec §4.1）：ssh 传 normalizeShellCommand 结果、mysql 传 ensureSemicolon 结果、redis 传 trim 结果。 */
  command: string;
  cwd?: string;
  evaluateShellPolicy: CommandPolicyEvaluate;
  evaluateMysqlPolicy: CommandPolicyEvaluate;
  evaluateRedisPolicy: CommandPolicyEvaluate;
}): Promise<AssetCommandAuthorization>;
```

`policy` 档三个 kind 走同一条路径：选对应评估器 → `try/catch` → `action === 'allow'` 才 `autoApprove: true`；`review` / `deny` / 抛异常 / 非法 action → `{ autoApprove: false, reasonCode, riskSummaries }`（异常时 `reasonCode: 'policy.initialization_failed'`）。`full` → `none` 的短路顺序、返回形状 `AssetCommandAuthorization`、`shouldAutoApproveSftpWrite` 全部不动。

- [ ] **Step 2: 改写姊妹测试**——`policy trust maps mysql/redis onto the read-only analyzers` 用例替换为：

```ts
it('policy trust maps mysql/redis onto the policy evaluators', async () => {
  const allow = vi.fn().mockResolvedValue({ action: 'allow', riskSummaries: [], reasonCode: 'ok' });
  const review = vi.fn().mockResolvedValue({ action: 'review', riskSummaries: ['statement writes data'], reasonCode: 'policy.unknown_semantics' });
  await expect(authorizeAssetCommand({ ...base, evaluateMysqlPolicy: allow, trust: 'policy', kind: 'mysql', command: 'SELECT 1;' }))
    .resolves.toMatchObject({ autoApprove: true });
  await expect(authorizeAssetCommand({ ...base, evaluateMysqlPolicy: review, trust: 'policy', kind: 'mysql', command: 'DROP TABLE t;' }))
    .resolves.toMatchObject({ autoApprove: false, riskSummaries: ['statement writes data'] });
  expect(review).toHaveBeenCalledWith({ command: 'DROP TABLE t;', cwd: undefined });
});

it('mysql/redis evaluator failures degrade to review, never to allow', async () => {
  const broken = vi.fn().mockRejectedValue(new Error('module missing'));
  await expect(authorizeAssetCommand({ ...base, evaluateRedisPolicy: broken, trust: 'policy', kind: 'redis', command: 'GET k' }))
    .resolves.toMatchObject({ autoApprove: false, reasonCode: 'policy.initialization_failed' });
});
```

`full` / `none` 的"评估器零调用"用例保持并覆盖三个注入项。

- [ ] **Step 3: Pass + commit**

```bash
npx vitest run test/agent/assetCommandTrust.test.ts
git add src/agent/assetCommandTrust.ts test/agent/assetCommandTrust.test.ts
git commit -m "feat: route mysql/redis limited trust through command-policy evaluators"
```

---

### Task 7: service 接真实评估器 + 精确文本 + 确认文案格式

**Files:**
- Modify: `src/agent/JumpServerAgentToolService.ts`
- Modify: `src/utils/commandPreview.ts`
- Modify: `test/agent/JumpServerAgentToolService.test.ts`
- Modify: `test/utils/commandPreview.test.ts`

- [ ] **Step 1: 写失败测试**（姊妹计划已覆盖 none/full/policy 三态、send_input、SFTP——不重复；本任务只加增量）

```ts
it('evaluates the normalized shell text and passes cwd separately', async () => {
  const evaluate = vi.fn().mockResolvedValue({ action: 'allow', riskSummaries: [], reasonCode: 'ok' });
  setCommandPolicyLoaderForTests(/* 或经 service 依赖注入 evaluate */);
  const service = serviceWith({ configManager: withTrust('policy') });
  await service.runTerminalCommand({ command: ' # note\n uptime \n df -h ', cwd: '/srv' });
  expect(evaluate).toHaveBeenCalledWith({ command: 'uptime; df -h', cwd: '/srv' });
});

it('evaluates ensureSemicolon(sql) for mysql', async () => {
  /* evaluate 捕获：{ command: 'SELECT 1;' }，即使入参是 'SELECT 1' */
});

it('confirmation carries policy note and redacted summaries', async () => {
  /* review + evidence → 消息含 'Policy: review (policy.unknown_semantics)' 与 '- Writes to a file path' */
});

it('deny verdicts confirm with a strong warning instead of silently refusing', async () => {
  /* deny → 消息含 'Policy: DENY'；用户确认后照常执行 */
});

it('redis blocking commands reject before any evaluator call, even under full trust', async () => {
  /* BLPOP + trust full → throw；evaluate 与 confirm 都未被调用 */
});
```

- [ ] **Step 2: `commandPreview.ts` 扩展**（spec §4.4 的格式即本步骤；若姊妹接线已按该格式实现则只补测试）

```ts
export function formatCommandConfirmMessage(options: {
  action: string;
  target: string;
  command: string;
  policyNote?: string;
  riskSummaries?: readonly string[];
}): string {
  const preview = truncateCommandPreview(options.command);
  const warning = isObviouslyDestructive(options.command)
    ? '\n\nWarning: this command appears destructive.'
    : '';
  const policyLines = [
    ...(options.policyNote ? [options.policyNote] : []),
    ...(options.riskSummaries ?? []).map((summary) => `- ${summary}`)
  ];
  const policyBlock = policyLines.length > 0 ? `\n\n${policyLines.join('\n')}` : '';
  return `${options.action} on ${options.target}?\n\n${preview}${warning}${policyBlock}`;
}
```

riskSummaries 是库保证 redacted 的固定措辞；插件**不得**自行把 sourceText / cwd / parser 错误拼进 `policyNote` 或日志。

- [ ] **Step 3: service 改动**

```ts
import {
  evaluateMysqlCommandPolicy,
  evaluateRedisCommandPolicy,
  evaluateShellCommandPolicy
} from './loadCommandPolicy';
import { ensureSemicolon, normalizeShellCommand /* … */ } from './TerminalExecutors';
```

- 缺省 `evaluateShellPolicy`：姊妹计划的 throw-stub 换成 `evaluateShellCommandPolicy`（其预留的"一行改动"，测试全保留）；新增缺省 `evaluateMysqlPolicy = evaluateMysqlCommandPolicy`、`evaluateRedisPolicy = evaluateRedisCommandPolicy`。
- `runTerminalCommand`：`authorizeAssetCommand` 的 `command` 实参改为 `normalizeShellCommand(command)`（`cwd: input.cwd` 不变）；确认框预览仍传原始 `command`；`policyNote` 按 spec §4.4 由 `authorization.action`/`reasonCode` 生成。
- `mysqlExecuteSql`：`command` 实参改为 `ensureSemicolon(sql)`；措辞选择用降权后的 `isReadOnlySql(sql)`（`'Run state-changing MySQL SQL'` vs `'Run JumpServer MySQL SQL'`，姊妹措辞规则不变）。
- `redisExecuteCommand`：`command` 实参为已 trim 的 `command`（现状即是）；措辞选择用 `isReadOnlyRedisCommand`。blocking / 多行拒绝保持在授权之前。
- `sendTerminalInput` **一行都不改**。决策拿到后不得改写任何一份文本再执行。

- [ ] **Step 4: 降权说明落地**——`SqlSafety.ts` / `RedisSafety.ts` 不删；给 `isReadOnlySql` / `isReadOnlyRedisCommand` 加 doc comment：仅用于确认文案措辞，**不再具有免确认权力**（gate 见 `assetCommandTrust.ts`）。验证：

```bash
rg -n "isReadOnlySql|isReadOnlyRedisCommand" src | rg -v "SqlSafety|RedisSafety"
```

期望：命中只出现在 service 的措辞选择处，不出现在任何 autoApprove / gate 逻辑里。

- [ ] **Step 5: Pass + commit**

```bash
npx vitest run test/agent/JumpServerAgentToolService.test.ts test/utils/commandPreview.test.ts
git add src/agent/JumpServerAgentToolService.ts src/agent/SqlSafety.ts src/agent/RedisSafety.ts src/utils/commandPreview.ts test/
git commit -m "feat: wire real policy evaluators with exact executable text and evidence UI"
```

---

### Task 8: catalog 措辞对齐 + 全量回归

**Files:**
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `test/mcp/toolCatalog.test.ts`（如有描述断言）

- [ ] **Step 1: 对齐三条命令工具的有限信任措辞**（姊妹计划已加三档说明；本步骤把 `policy` 档的表述改准——由 command policy 证明只读才免确认，不再是"read-only 语句免确认"）。`name` / `risk` / `inputSchema` 不动；`jumpserver_send_terminal_input` 描述保持 "after confirmation"。

- [ ] **Step 2: 全量回归**

```bash
npm run typecheck
npm test
npm run build
npx vitest run test/package.policyBundle.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: align tool catalog limited-trust wording with command policy"
```

---

### Task 9: 验收清单（有证据才勾）

**Phase A（可独立验收）：**

- [ ] `package.json` 里 `@at-series/command-policy` 为精确 `0.1.1`（无 `^`/`~`/`file:`）
- [ ] mcp-hub 与 command-policy 源码零改动；未发布 command-policy 新版本
- [ ] `dist/extension.js` 不含 `createShellPolicyEvaluator` / `tree-sitter-bash` / `@at-series/command-policy` 字面量（`test/package.policyBundle.test.ts` 绿）
- [ ] 冒烟哨兵绿：`uptime` → `allow`，`python3 -c "print(1)"` → `allow`（banner/define 在位）
- [ ] `dist/policy-assets/` 含 3 个 WASM + NOTICE，随 VSIX 打包
- [ ] loader fail-closed 用例绿（loader 抛错、dist 缺失、action 非法 → 全部 `review`）
- [ ] 评估文本锚定用例绿（shell `normalizeShellCommand` / mysql `ensureSemicolon`）

**Phase B（前置：trust-mode 已合入）：**

- [ ] `authorizeAssetCommand` 的 mysql / redis 分支不再引用只读启发式；`none` / `full` 下三个评估器零调用（spy 断言）
- [ ] service 缺省评估器 = `evaluate{Shell,Mysql,Redis}CommandPolicy`；ssh 传 `normalizeShellCommand(command)` + 单独 `cwd`、mysql 传 `ensureSemicolon(sql)`、redis 传 trim 后文本（捕获断言绿）
- [ ] `sendTerminalInput` 在 `full` 下仍确认；Redis blocking 在任何 trust 下仍先行硬拒绝（评估器零调用）
- [ ] 确认文案含 `Policy: …` note 与 `- <summary>` 行，`deny` 有强警示；文案中无 sourceText / cwd / parser 错误（预览除外）
- [ ] `rg -n "isReadOnlySql|isReadOnlyRedisCommand" src` 命中仅剩定义与措辞选择处，无 gate 用途
- [ ] 手工冒烟：`policy` 资产 `uptime` 不弹框、`rm /tmp/x` 弹框附摘要；`none` 资产 `SELECT 1` 弹框；`full` 资产命令不弹框但 send_input 弹框
- [ ] Release note 写明默认 `none` 的确认收紧；与 trust-mode 计划同 release 发布

---

## Plan self-review

1. **Spec coverage:** 设计 D1–D14 逐条有落点——版本锁定（Task 1）、bundle/banner/define/WASM（Task 2）、冒烟哨兵（Task 3）、懒加载 + 评估入口（Task 4）、文本锚定（Task 5）、门注入替换（Task 6）、精确文本 + 文案格式 + 启发式降权（Task 7）、catalog 对齐（Task 8）、验收（Task 9）。
2. **Sibling consistency:** 门骨架 / trust 存储 / service 首轮接线归姊妹计划（其 Task 2–4），本计划只做其预留的注入替换（ssh 一行改动 + mysql/redis 签名扩展并改写其测试）；`CommandPolicyEvaluate` 的输入输出形状与姊妹设计 §6.1 的 `ShellPolicyEvaluate` 占位逐字段一致。
3. **Placeholders:** 无。工厂名 / 入口 specifier / reason code 对照 command-policy `docs/api.md` 0.1.1 核实；代码骨架可直接落盘，实现者只需补 fixture 细节。
4. **顺序依赖:** Task 1→2→3（先有 bundle 才能冒烟）；Task 4、5 相互独立、依赖 Task 1；Phase B 整体前置 trust-mode Task 3–4（Task 6 开头有存在性检查）；Task 7 依赖 Task 6；Task 8 收尾。Phase A 单独合入无任何行为变化，安全。
