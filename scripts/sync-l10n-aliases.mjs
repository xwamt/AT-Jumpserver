import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * vscode.l10n and package.nls load `*.${vscode.env.language}.*` with no
 * fallback. Official VS Code uses zh-cn; Microsoft's pack and forks such as
 * Antigravity often report zh-hans or zh. Keep one zh-cn source of truth.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const aliases = ['zh-hans', 'zh'];

for (const locale of aliases) {
  copyFileSync(join(root, 'package.nls.zh-cn.json'), join(root, `package.nls.${locale}.json`));
  copyFileSync(
    join(root, 'l10n', 'bundle.l10n.zh-cn.json'),
    join(root, 'l10n', `bundle.l10n.${locale}.json`)
  );
}

console.log(`copied zh-cn l10n onto ${aliases.join(', ')}`);
