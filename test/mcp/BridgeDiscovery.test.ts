import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bridgeDiscoveryFile,
  readBridgeDiscovery,
  removeBridgeDiscovery,
  writeBridgeDiscovery
} from '../../src/mcp/BridgeDiscovery';

describe('JumpServer BridgeDiscovery', () => {
  it('uses a JumpServer-specific discovery file', () => {
    expect(bridgeDiscoveryFile('C:/Users/test').replaceAll('\\', '/')).toBe(
      'C:/Users/test/.at-jumpserver-terminal/mcp-bridge.json'
    );
  });

  it('writes and reads valid bridge discovery data', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-read');
    await writeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123, updatedAt: 456 });
    await expect(readBridgeDiscovery(home)).resolves.toEqual({
      port: 39451,
      token: 'secret',
      pid: 123,
      updatedAt: 456
    });
  });

  it('ignores invalid discovery data', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-invalid');
    const file = bridgeDiscoveryFile(home);
    await mkdir(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(file, JSON.stringify({ port: 0, token: '', pid: 'bad', updatedAt: 1 }), 'utf8');
    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('removes discovery only when the owner matches', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-bridge-discovery-remove');
    await writeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123, updatedAt: 456 });
    await removeBridgeDiscovery(home, { port: 39451, token: 'wrong', pid: 123 });
    await expect(readBridgeDiscovery(home)).resolves.toBeDefined();
    await removeBridgeDiscovery(home, { port: 39451, token: 'secret', pid: 123 });
    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('does not use the ssh-plugins discovery path', () => {
    expect(bridgeDiscoveryFile('C:/Users/test').replaceAll('\\', '/')).not.toContain('/.at-terminal/');
  });
});
