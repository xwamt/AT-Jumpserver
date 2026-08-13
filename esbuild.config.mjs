import * as esbuild from 'esbuild';

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

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
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
  })
];

const contexts = await Promise.all(contextConfigs);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching AT JumpServer Terminal bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
