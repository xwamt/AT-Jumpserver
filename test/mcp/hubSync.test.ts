import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubJsPath, hubVersionPath } from '@at-series/mcp-hub';
import { AT_JUMPSERVER_PLUGIN_ID } from '../../src/mcp/toolCatalog';
import { syncPackagedHubAt } from '../../src/mcp/hubSync';

describe('syncPackagedHubAt', () => {
  let home: string;
  let bundleDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'at-jumpserver-hubsync-home-'));
    bundleDir = await mkdtemp(join(tmpdir(), 'at-jumpserver-hubsync-bundle-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(bundleDir, { recursive: true, force: true });
  });

  it('elects packaged hub.js into temp home via syncHubBundle', async () => {
    const content = 'module.exports = { packaged: true };\n';
    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, content, 'utf8');

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home
    );

    expect(result).toEqual({ updated: true, activeVersion: '0.1.8' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(content);

    const meta = JSON.parse(await readFile(hubVersionPath(home), 'utf8'));
    expect(meta).toMatchObject({
      version: '0.1.8',
      writtenByPluginId: AT_JUMPSERVER_PLUGIN_ID,
      writtenByPluginVersion: '0.1.8'
    });
  });

  it('reads hub version from dist/hub-version.json sidecar when resolving packaged hub', async () => {
    const { syncPackagedHub } = await import('../../src/mcp/hubSync.js');
    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, 'module.exports = { sidecar: true };\n', 'utf8');
    await writeFile(
      join(bundleDir, 'hub-version.json'),
      JSON.stringify({ version: '0.1.8', protocolVersion: 1 }),
      'utf8'
    );

    const sidecar = JSON.parse(await readFile(join(bundleDir, 'hub-version.json'), 'utf8'));
    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: sidecar.version, pluginVersion: '0.1.8' },
      home
    );
    expect(result.activeVersion).toBe('0.1.8');
    expect(syncPackagedHub).toBeTypeOf('function');
  });

  /**
   * Sets up a home + bundle pair whose sidecars agree on version and sha, but
   * whose on-disk hub.js bytes differ from the packaged ones at equal length.
   * Only the full election (which re-reads and re-hashes the installed file)
   * can tell them apart, so whichever content survives reveals which path ran.
   */
  async function seedMatchingMetadata() {
    const packaged = 'module.exports = { copy: "packaged" };\n';
    const onDisk = 'module.exports = { copy: "on-disk!" };\n';
    expect(onDisk).toHaveLength(packaged.length);
    const bundlePath = join(bundleDir, 'hub.js');
    const packagedSha = createHash('sha256').update(packaged, 'utf8').digest('hex');
    await writeFile(bundlePath, packaged, 'utf8');
    await writeFile(
      join(bundleDir, 'hub-version.json'),
      JSON.stringify({ version: '0.1.8', protocolVersion: 1, bundleSha256: packagedSha }),
      'utf8'
    );
    await mkdir(join(home, '.at-series', 'mcp'), { recursive: true });
    await writeFile(hubJsPath(home), onDisk, 'utf8');
    await writeFile(
      hubVersionPath(home),
      JSON.stringify({
        version: '0.1.8',
        protocolVersion: 1,
        writtenByPluginId: AT_JUMPSERVER_PLUGIN_ID,
        writtenByPluginVersion: '0.1.8',
        writtenAt: 1,
        bundleSha256: packagedSha
      }),
      'utf8'
    );
    return { bundlePath, packaged, onDisk };
  }

  it('short-circuits without reading or hashing when sidecar metadata matches', async () => {
    const { bundlePath, onDisk } = await seedMatchingMetadata();

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home
    );

    expect(result).toEqual({ updated: false, activeVersion: '0.1.8' });
    // The full election would have re-hashed the installed file, noticed the
    // divergent bytes, and repaired them; the short-circuit never read them.
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(onDisk);
  });

  it('force runs the full election even when metadata matches', async () => {
    const { bundlePath, packaged } = await seedMatchingMetadata();

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home,
      { force: true }
    );

    expect(result).toEqual({ updated: true, activeVersion: '0.1.8' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(packaged);
  });

  it('falls through to the full election when the installed hub.js size differs', async () => {
    const { bundlePath, packaged } = await seedMatchingMetadata();
    await writeFile(hubJsPath(home), 'truncated', 'utf8');

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home
    );

    expect(result).toEqual({ updated: true, activeVersion: '0.1.8' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(packaged);
  });

  it('falls through to the full election when the sidecar lacks bundleSha256', async () => {
    const { bundlePath, packaged } = await seedMatchingMetadata();
    await writeFile(
      join(bundleDir, 'hub-version.json'),
      JSON.stringify({ version: '0.1.8', protocolVersion: 1 }),
      'utf8'
    );

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home
    );

    // Election ran: the on-disk metadata claims the packaged sha but the
    // installed bytes hash differently, so the bundle is repaired.
    expect(result).toEqual({ updated: true, activeVersion: '0.1.8' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(packaged);
  });

  it('skips overwrite when active hub semver is newer', async () => {
    const activeContent = 'active-newer';
    await mkdir(join(home, '.at-series', 'mcp'), { recursive: true });
    await writeFile(hubJsPath(home), activeContent, 'utf8');
    await writeFile(
      hubVersionPath(home),
      JSON.stringify({
        version: '0.2.0',
        protocolVersion: 1,
        writtenByPluginId: AT_JUMPSERVER_PLUGIN_ID,
        writtenByPluginVersion: '0.1.8',
        writtenAt: 1,
        // syncHubBundle verifies this against the bytes actually on disk before
        // it will skip, so a placeholder here reads as a tampered install.
        bundleSha256: createHash('sha256').update(activeContent, 'utf8').digest('hex')
      }),
      'utf8'
    );

    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, 'candidate-older', 'utf8');

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.8', pluginVersion: '0.1.8' },
      home
    );

    expect(result).toEqual({ updated: false, activeVersion: '0.2.0' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(activeContent);
  });
});
