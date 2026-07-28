import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContinueMcpConfig,
  cursorMcpConfigPath,
  installIdeMcpConfig,
  kiroMcpConfigPath,
  resolveIdeMcpConfigTarget
} from '../../src/mcp/McpConfigInstaller';

describe('JumpServer McpConfigInstaller', () => {
  it('builds Continue config with JumpServer server name', () => {
    expect(buildContinueMcpConfig('C:\\ext\\dist\\mcp-server.js')).toContain('name: AT JumpServer Terminal');
    expect(buildContinueMcpConfig('C:\\ext\\dist\\mcp-server.js')).toContain('C:/ext/dist/mcp-server.js');
  });

  it('resolves Kiro and Cursor targets', () => {
    expect(resolveIdeMcpConfigTarget({ appName: 'Kiro' })).toEqual({ id: 'kiro', displayName: 'Kiro' });
    expect(resolveIdeMcpConfigTarget({ appName: 'Cursor' })).toEqual({ id: 'cursor', displayName: 'Cursor' });
  });

  it('writes Kiro MCP config without removing existing servers', async () => {
    const home = join(process.cwd(), '.tmp-jumpserver-mcp-installer');
    const existingPath = kiroMcpConfigPath(home);
    await mkdir(existingPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(existingPath, JSON.stringify({ mcpServers: { Existing: { command: 'node', args: ['old.js'] } } }), 'utf8');

    await installIdeMcpConfig({
      home,
      target: { id: 'kiro', displayName: 'Kiro' },
      mcpServerPath: join(home, 'dist', 'mcp-server.js'),
      waitForServerMs: 0
    });
    const parsed = JSON.parse(await readFile(existingPath, 'utf8'));
    expect(parsed.mcpServers.Existing).toBeDefined();
    expect(parsed.mcpServers['AT JumpServer Terminal']).toMatchObject({ command: 'node' });
  });

  it('uses a Cursor-specific config path', () => {
    expect(cursorMcpConfigPath('C:/Users/test').replaceAll('\\', '/')).toBe('C:/Users/test/.cursor/mcp.json');
  });
});
