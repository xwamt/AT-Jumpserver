import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jumpserver-config/index.ts'],
    outfile: 'dist/webview/jumpserver-config.js',
    platform: 'browser',
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jumpserver-config/index.css'],
    outfile: 'dist/webview/jumpserver-config.css',
    bundle: true,
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
