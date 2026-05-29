import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JUMPSERVER_MCP_TOOL_NAMES } from '../../src/mcp/BridgeProtocol';

describe('JumpServer MCP server', () => {
  it('registers every JumpServer MCP tool name', async () => {
    const text = await readFile('src/mcp/server.ts', 'utf8');
    for (const toolName of JUMPSERVER_MCP_TOOL_NAMES) {
      expect(text).toContain(`'${toolName}'`);
    }
    expect(text).toContain("name: 'at-jumpserver-terminal'");
  });
});
