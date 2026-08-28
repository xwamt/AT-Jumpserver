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
