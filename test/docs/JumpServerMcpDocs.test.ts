import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('JumpServer MCP docs', () => {
  it('documents Continue config with JumpServer MCP server name', async () => {
    const text = await readFile('docs/mcp/continue-at-jumpserver-terminal-mcp.yaml', 'utf8');
    expect(text).toContain('AT JumpServer Terminal');
    expect(text).toContain('dist/mcp-server.js');
  });

  it('documents JumpServer-specific MCP tool workflow in the skill', async () => {
    const text = await readFile('skills/at-jumpserver-terminal-mcp/SKILL.md', 'utf8');
    expect(text).toContain('jumpserver_get_terminal_context');
    expect(text).toContain('jumpserver_mysql_execute_sql');
    expect(text).toContain('Do not read local VS Code secret storage');
  });

  it('mentions MCP support in README', async () => {
    const text = await readFile('README.md', 'utf8');
    expect(text).toContain('MCP');
    expect(text).toContain('JumpServer: Install MCP Config');
  });
});
