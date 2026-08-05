import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('JumpServer MCP docs', () => {
  it('documents JumpServer-specific MCP tool workflow in the skill', async () => {
    const text = await readFile('skills/at-jumpserver-terminal-mcp/SKILL.md', 'utf8');
    expect(text).toContain('jumpserver_get_terminal_context');
    expect(text).toContain('jumpserver_send_terminal_input');
    expect(text).toContain('jumpserver_mysql_execute_sql');
    expect(text).toContain('jumpserver_redis_execute_command');
    expect(text).not.toContain('jumpserver_mysql_get_context');
    expect(text).not.toContain('jumpserver_mysql_send_input');
  });

  it('mentions MCP support in README', async () => {
    const text = await readFile('README.md', 'utf8');
    expect(text).toContain('MCP');
    expect(text).toContain('Install/Repair AT Series MCP Config');
  });
});
