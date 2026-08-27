import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Copy the hub bundle into dist/ and write the hub-version.json sidecar.
 * Exported so the esbuild watch pipeline can re-run it after rebuilds.
 */
export function copyHub() {
  const hubEntry = require.resolve('@at-series/mcp-hub/hub');
  const hubPkgPath = join(dirname(hubEntry), '..', 'package.json');
  const hubPkg = JSON.parse(readFileSync(hubPkgPath, 'utf8'));
  const { AT_SERIES_HUB_PROTOCOL_VERSION } = require('@at-series/mcp-hub');

  mkdirSync('dist', { recursive: true });
  copyFileSync(hubEntry, join('dist', 'hub.js'));
  // Hash the copied file rather than the source so the sidecar always
  // describes the exact bytes shipped in the VSIX. hubSync's activation
  // short-circuit compares this against ~/.at-series/mcp/hub-version.json to
  // skip re-reading and re-hashing ~400KB on every window start.
  const bundleSha256 = createHash('sha256')
    .update(readFileSync(join('dist', 'hub.js')))
    .digest('hex');
  writeFileSync(
    join('dist', 'hub-version.json'),
    `${JSON.stringify(
      {
        version: hubPkg.version,
        protocolVersion: AT_SERIES_HUB_PROTOCOL_VERSION,
        bundleSha256
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return { version: hubPkg.version, protocolVersion: AT_SERIES_HUB_PROTOCOL_VERSION, bundleSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = copyHub();
  console.log(
    `copied hub.js (${result.version}) + hub-version.json (protocol ${result.protocolVersion}, sha256 ${result.bundleSha256.slice(0, 12)})`
  );
}
