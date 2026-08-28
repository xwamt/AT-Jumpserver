import * as esbuild from 'esbuild';
import { copyHub } from './scripts/copy-hub.mjs';

const watch = process.argv.includes('--watch');

// Watch builds stay unminified and mapped so the debugger lands on real source.
// Shipped builds are minified and emit no sourcemap at all: .vscodeignore keeps
// every **/*.map file out of the VSIX, so emitting them would leave each bundle
// ending in a sourceMappingURL pointing at a file that was never packaged.
const common = {
  bundle: true,
  sourcemap: watch,
  minify: !watch
};

/** VS Code 1.85 runs Node 18 in the extension host and Chromium 114 in webviews. */
const NODE_TARGET = 'node18';
const BROWSER_TARGET = 'chrome114';

// One-shot builds copy the hub via the `copy:hub` npm script; watch rebuilds
// have no such step, so refresh dist/hub.js + hub-version.json (including the
// bundleSha256 the activation short-circuit relies on) after each rebuild.
const copyHubOnRebuild = {
  name: 'copy-hub-on-rebuild',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        return;
      }
      try {
        copyHub();
      } catch (error) {
        console.error('copy-hub failed:', error);
      }
    });
  }
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: NODE_TARGET,
    format: 'cjs',
    // The MCP runtime ships as its own bundle (below) that extension.js loads
    // lazily via require(asAbsolutePath('dist/mcpRuntime.js')). Its source
    // specifier is only a fallback for the vitest harness; marking it external
    // keeps @at-series/mcp-hub out of extension.js.
    external: ['vscode', './mcp/mcpRuntime.js'],
    plugins: watch ? [copyHubOnRebuild] : []
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/mcp/mcpRuntime.ts'],
    outfile: 'dist/mcpRuntime.js',
    platform: 'node',
    target: NODE_TARGET,
    format: 'cjs',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    target: BROWSER_TARGET,
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jumpserver-config/index.ts'],
    outfile: 'dist/webview/jumpserver-config.js',
    platform: 'browser',
    target: BROWSER_TARGET,
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jumpserver-config/index.css'],
    outfile: 'dist/webview/jumpserver-config.css',
    bundle: true,
    target: BROWSER_TARGET,
    loader: { '.css': 'css' }
  }),
  // The command-policy engine ships as its own CJS bundle that extension.js
  // loads lazily via require(join(__dirname, 'policy-runtime.js')), mirroring
  // the mcpRuntime split so dist/extension.js stays free of policy code.
  // banner + define are both mandatory: web-tree-sitter dereferences
  // import.meta.url at runtime, and without them there is no build error and
  // no runtime exception — embedded python payloads (python3 -c) just silently
  // fail closed to review. test/package.policyBundle.test.ts guards this.
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
];

const contexts = await Promise.all(contextConfigs);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  const { copyPolicyRuntimeAssets } = await import('./scripts/copy-policy-assets.mjs');
  await copyPolicyRuntimeAssets();
  console.log('Watching AT JumpServer Terminal bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  const { copyPolicyRuntimeAssets } = await import('./scripts/copy-policy-assets.mjs');
  await copyPolicyRuntimeAssets();
}
