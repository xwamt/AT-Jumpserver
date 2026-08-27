import { access, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { hubJsPath, hubVersionPath, syncHubBundle } from '@at-series/mcp-hub';
import * as vscode from 'vscode';
import { AT_JUMPSERVER_PLUGIN_ID } from './toolCatalog';

const require = createRequire(__filename);

export interface SyncPackagedHubOptions {
  /**
   * Skip the metadata short-circuit and run the full read+hash election.
   * The Repair command uses this so a user asking for a repair always gets
   * the tamper-checking path, whatever the sidecars claim.
   */
  force?: boolean;
}

interface PackagedHubSidecar {
  version?: string;
  bundleSha256?: string;
}

/** Build-time sidecar written next to dist/hub.js by scripts/copy-hub.mjs. */
async function readPackagedSidecar(bundlePath: string): Promise<PackagedHubSidecar | undefined> {
  const sidecar = join(dirname(bundlePath), 'hub-version.json');
  try {
    const raw = await readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown; bundleSha256?: unknown };
    return {
      version: typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined,
      bundleSha256:
        typeof parsed.bundleSha256 === 'string' && parsed.bundleSha256.length > 0
          ? parsed.bundleSha256
          : undefined
    };
  } catch {
    return undefined;
  }
}

async function resolveHubPackageVersion(bundlePath: string): Promise<string> {
  const sidecar = await readPackagedSidecar(bundlePath);
  if (sidecar?.version) {
    return sidecar.version;
  }

  // Fall through to node_modules resolution (dev / file: link).
  try {
    return require('@at-series/mcp-hub/package.json').version as string;
  } catch {
    const hubEntry = require.resolve('@at-series/mcp-hub/hub');
    const pkgPath = join(dirname(hubEntry), '..', 'package.json');
    return require(pkgPath).version as string;
  }
}

/**
 * `syncHubBundle` reads and hashes both the packaged and the installed hub.js
 * (~400KB each) under a file lock — every window start pays that even when
 * nothing changed. When the build-time sidecar and the on-disk metadata agree
 * on version AND bundleSha256, a pair of stat calls confirming the installed
 * file still has the packaged size is enough to skip the election entirely.
 * Any mismatch (or a missing/undersized/oversized hub.js) falls through to
 * the full election, which keeps the tamper-repair behavior intact.
 */
async function trySkipHubSync(
  bundlePath: string,
  hubVersion: string,
  home?: string
): Promise<{ updated: false; activeVersion: string } | undefined> {
  try {
    const sidecar = await readPackagedSidecar(bundlePath);
    if (!sidecar?.bundleSha256 || sidecar.version !== hubVersion) {
      return undefined;
    }
    const onDiskMeta = JSON.parse(await readFile(hubVersionPath(home), 'utf8')) as {
      version?: unknown;
      bundleSha256?: unknown;
    };
    if (onDiskMeta.version !== sidecar.version || onDiskMeta.bundleSha256 !== sidecar.bundleSha256) {
      return undefined;
    }
    const [packagedStat, onDiskStat] = await Promise.all([stat(bundlePath), stat(hubJsPath(home))]);
    if (packagedStat.size !== onDiskStat.size) {
      return undefined;
    }
    return { updated: false, activeVersion: sidecar.version };
  } catch {
    // Missing/corrupt metadata or hub.js: the full election heals it.
    return undefined;
  }
}

export async function syncPackagedHubAt(
  bundlePath: string,
  versions: { hubVersion: string; pluginVersion: string },
  home?: string,
  options: SyncPackagedHubOptions = {}
): Promise<{ updated: boolean; activeVersion: string }> {
  await access(bundlePath);
  if (!options.force) {
    const skipped = await trySkipHubSync(bundlePath, versions.hubVersion, home);
    if (skipped) {
      return skipped;
    }
  }
  return syncHubBundle({
    version: versions.hubVersion,
    bundlePath,
    pluginId: AT_JUMPSERVER_PLUGIN_ID,
    pluginVersion: versions.pluginVersion,
    home
  });
}

export async function syncPackagedHub(
  context: vscode.ExtensionContext,
  options: SyncPackagedHubOptions = {}
): Promise<{ updated: boolean; activeVersion: string }> {
  const bundlePath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'hub.js').fsPath;
  const hubVersion = await resolveHubPackageVersion(bundlePath);
  return syncPackagedHubAt(
    bundlePath,
    {
      hubVersion,
      pluginVersion: String(context.extension.packageJSON.version)
    },
    undefined,
    options
  );
}
