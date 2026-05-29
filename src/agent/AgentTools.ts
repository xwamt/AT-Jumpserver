import * as vscode from 'vscode';
import type { JumpServerAgentToolService } from './JumpServerAgentToolService';

type ToolInput = Record<string, unknown>;

export function registerAgentTools(service: JumpServerAgentToolService): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('jumpserver_list_assets', new JsonTool(() => service.listAssets())),
    vscode.lm.registerTool('jumpserver_get_terminal_context', new JsonTool(() => service.getTerminalContext())),
    vscode.lm.registerTool('jumpserver_send_terminal_input', new JsonTool((input) => service.sendTerminalInput(input as never))),
    vscode.lm.registerTool('jumpserver_run_terminal_command', new JsonTool((input) => service.runTerminalCommand(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_list_directory', new JsonTool((input) => service.sftpListDirectory(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_stat_path', new JsonTool((input) => service.sftpStatPath(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_read_file', new JsonTool((input) => service.sftpReadFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_write_file', new JsonTool((input) => service.sftpWriteFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_create_file', new JsonTool((input) => service.sftpCreateFile(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_create_directory', new JsonTool((input) => service.sftpCreateDirectory(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_rename', new JsonTool((input) => service.sftpRename(input as never))),
    vscode.lm.registerTool('jumpserver_sftp_delete', new JsonTool((input) => service.sftpDelete(input as never))),
    vscode.lm.registerTool('jumpserver_mysql_get_context', new JsonTool(() => service.mysqlGetContext())),
    vscode.lm.registerTool('jumpserver_mysql_send_input', new JsonTool((input) => service.mysqlSendInput(input as never))),
    vscode.lm.registerTool('jumpserver_mysql_execute_sql', new JsonTool((input) => service.mysqlExecuteSql(input as never)))
  ];
}

class JsonTool<TInput extends ToolInput> implements vscode.LanguageModelTool<TInput> {
  constructor(private readonly invokeJson: (input: TInput) => Promise<unknown>) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<TInput>): Promise<vscode.LanguageModelToolResult> {
    const value = await this.invokeJson(options.input ?? {} as TInput);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
    ]);
  }
}
