import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('JumpServer MCP docs', () => {
  it('documents Continue config pointing at the shared AT Series hub', async () => {
    const text = await readFile('docs/mcp/continue-at-jumpserver-terminal-mcp.yaml', 'utf8');
    expect(text).toContain('AT Series');
    expect(text).toContain('.at-series/mcp/hub.js');
    expect(text).toContain('AT_SERIES_HOST_APP: continue');
  });

  it('does not resurrect the per-plugin MCP server entry', async () => {
    // The hub migration removed dist/mcp-server.js as a product entry point.
    // A sample config that still names it would send users to a file that no
    // longer ships, and would reintroduce a second MCP server per IDE.
    const text = await readFile('docs/mcp/continue-at-jumpserver-terminal-mcp.yaml', 'utf8');
    expect(text).not.toContain('mcp-server.js');
    expect(text).not.toContain('AT JumpServer Terminal');
  });

  it('documents JumpServer-specific MCP tool workflow in the skill', async () => {
    const text = await readFile('skills/at-jumpserver-terminal-mcp/SKILL.md', 'utf8');
    expect(text).toContain('jumpserver_get_terminal_context');
    expect(text).toContain('jumpserver_send_terminal_input');
    expect(text).toContain('jumpserver_mysql_execute_sql');
    expect(text).toContain('jumpserver_redis_execute_command');
    expect(text).not.toContain('jumpserver_mysql_get_context');
    expect(text).not.toContain('jumpserver_mysql_send_input');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/discover\s*→\s*select/i);
    expect(match![1]).not.toMatch(/first-class call/i);
  });

  it('mentions MCP support in README', async () => {
    const text = await readFile('README.md', 'utf8');
    expect(text).toContain('MCP');
    expect(text).toContain('Install/Repair AT Series MCP Config');
  });
});
