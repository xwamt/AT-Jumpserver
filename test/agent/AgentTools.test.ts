import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentTools } from '../../src/agent/AgentTools';

describe('JumpServer AgentTools', () => {
  it('registers every JumpServer language model tool', () => {
    const service = new Proxy({}, { get: () => vi.fn(async () => ({})) });
    registerAgentTools(service as never);
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_list_assets', expect.anything());
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_mysql_execute_sql', expect.anything());
    expect(vscode.lm.registerTool).toHaveBeenCalledWith('jumpserver_sftp_delete', expect.anything());
  });
});
