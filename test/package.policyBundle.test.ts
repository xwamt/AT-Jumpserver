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

  it('keeps policy engine code out of dist/extension.js', () => {
    expect(extensionBundle).not.toContain('createShellPolicyEvaluator');
    expect(extensionBundle).not.toContain('tree-sitter-bash');
    expect(extensionBundle).not.toContain('@at-series/command-policy');
    // Since Phase B the extension bundles the lazy loader (loadCommandPolicy),
    // which references the factory by property name; the reference must stay a
    // dynamic property access on the runtime require, never a static import.
    const occurrences = extensionBundle.split('createJumpServerPolicyRuntime').length - 1;
    expect(occurrences).toBeGreaterThan(0);
    expect(occurrences).toBeLessThanOrEqual(3);
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
