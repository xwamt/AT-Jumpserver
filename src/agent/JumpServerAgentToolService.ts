import type { JumpServerConfigManager } from '../config/JumpServerConfigManager';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind } from '../jumpserver/connectionTypes';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import type { JumpServerSftpEntry } from '../sftp/SftpTypes';
import type { ActiveTerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import { isReadOnlySql } from './SqlSafety';
import { MysqlCliExecutor, ShellTerminalExecutor } from './TerminalExecutors';

export interface JumpServerAgentToolServiceDependencies {
  configManager: Pick<JumpServerConfigManager, 'listCachedAssets'>;
  terminalContext: TerminalContextRegistry;
  sftp: Pick<JumpServerSftpManager,
    'listDirectory' | 'stat' | 'readFile' | 'writeFile' | 'createFile' | 'mkdir' | 'rename' | 'deleteEntry'
  >;
  confirm(message: string): Promise<boolean>;
  shellExecutor?: ShellTerminalExecutor;
  mysqlExecutor?: MysqlCliExecutor;
}

export class JumpServerAgentToolService {
  private readonly shellExecutor: ShellTerminalExecutor;
  private readonly mysqlExecutor: MysqlCliExecutor;
  private readonly terminalQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly dependencies: JumpServerAgentToolServiceDependencies) {
    this.shellExecutor = dependencies.shellExecutor ?? new ShellTerminalExecutor();
    this.mysqlExecutor = dependencies.mysqlExecutor ?? new MysqlCliExecutor();
  }

  private enqueueTerminal<T>(terminalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.terminalQueues.get(terminalId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.terminalQueues.set(
      terminalId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  async listAssets() {
    const assets = await this.dependencies.configManager.listCachedAssets();
    return { assets: assets.map(assetSummary) };
  }

  async getTerminalContext() {
    return this.dependencies.terminalContext.getSnapshot();
  }

  async sendTerminalInput(input: { terminalId?: string; input?: string }) {
    const target = this.resolveTerminal(input.terminalId);
    const data = input.input ?? '';
    await this.requireConfirm(
      `Send input to JumpServer terminal on ${target.asset.name}?\n\n${previewInput(data)}`
    );
    target.write(data);
    return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
  }

  async runTerminalCommand(input: {
    terminalId?: string;
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }) {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Terminal command cannot be empty.');
    }
    const target = this.resolveTerminal(input.terminalId);
    if (getAssetConnectionKind(target.asset) !== 'ssh') {
      throw new Error('A connected JumpServer SSH terminal is required.');
    }
    if (!await this.dependencies.confirm(`Run JumpServer SSH command on ${target.asset.name}?\n\n${command}`)) {
      throw new Error('Terminal command was cancelled.');
    }
    // Serialize per terminal so parallel MCP tool calls cannot interleave wrappers
    // on the same PTY (which looks like "one confirm ran three commands").
    return await this.enqueueTerminal(target.terminalId, async () => {
      const liveTarget = this.resolveTerminal(target.terminalId);
      const output = this.requireOutput(liveTarget.terminalId);
      return await this.shellExecutor.execute({
        terminalId: liveTarget.terminalId,
        assetId: liveTarget.asset.id,
        assetName: liveTarget.asset.name,
        command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        write: liveTarget.write,
        output
      });
    });
  }

  async sftpListDirectory(input: { connectionKey?: string; terminalId?: string; path?: string }) {
    return {
      path: input.path,
      entries: await this.dependencies.sftp.listDirectory(input.path)
    };
  }

  async sftpStatPath(input: { connectionKey?: string; terminalId?: string; path: string }) {
    return await this.dependencies.sftp.stat(input.path, input.connectionKey ?? input.terminalId);
  }

  async sftpReadFile(input: { connectionKey?: string; terminalId?: string; path: string; maxBytes?: number }) {
    const maxBytes = clampReadBytes(input.maxBytes);
    const buffer = await this.dependencies.sftp.readFile(input.path, maxBytes, input.connectionKey ?? input.terminalId);
    if (buffer.includes(0)) {
      throw new Error('Remote file appears to be binary.');
    }
    return { path: input.path, content: buffer.toString('utf8'), truncated: buffer.byteLength >= maxBytes };
  }

  async sftpWriteFile(input: {
    connectionKey?: string;
    terminalId?: string;
    path: string;
    content: string;
    overwrite?: boolean;
  }) {
    await this.requireConfirm(`Write JumpServer SFTP file ${input.path}?`);
    await this.dependencies.sftp.writeFile(
      input.path,
      Buffer.from(input.content, 'utf8'),
      input.connectionKey ?? input.terminalId
    );
    return { path: input.path, bytesWritten: Buffer.byteLength(input.content, 'utf8') };
  }

  async sftpCreateFile(input: { connectionKey?: string; terminalId?: string; path: string; content?: string }) {
    await this.requireConfirm(`Create JumpServer SFTP file ${input.path}?`);
    if (input.content === undefined) {
      await this.dependencies.sftp.createFile(input.path, input.connectionKey ?? input.terminalId);
    } else {
      await this.dependencies.sftp.writeFile(
        input.path,
        Buffer.from(input.content, 'utf8'),
        input.connectionKey ?? input.terminalId
      );
    }
    return { path: input.path };
  }

  async sftpCreateDirectory(input: { connectionKey?: string; terminalId?: string; path: string }) {
    await this.requireConfirm(`Create JumpServer SFTP directory ${input.path}?`);
    await this.dependencies.sftp.mkdir(input.path);
    return { path: input.path };
  }

  async sftpRename(input: { connectionKey?: string; terminalId?: string; oldPath: string; newPath: string }) {
    await this.requireConfirm(`Rename JumpServer SFTP path ${input.oldPath} to ${input.newPath}?`);
    await this.dependencies.sftp.rename(input.oldPath, input.newPath);
    return { oldPath: input.oldPath, newPath: input.newPath };
  }

  async sftpDelete(input: { connectionKey?: string; terminalId?: string; path: string; type?: JumpServerSftpEntry['type'] }) {
    await this.requireConfirm(`Delete JumpServer SFTP path ${input.path}?`);
    await this.dependencies.sftp.deleteEntry({
      name: input.path.split('/').filter(Boolean).pop() || input.path,
      path: input.path,
      type: input.type ?? 'file'
    });
    return { path: input.path, deleted: true };
  }

  async mysqlGetContext() {
    const snapshot = this.dependencies.terminalContext.getSnapshot();
    return {
      activeTerminal: snapshot.activeTerminal?.connectionKind === 'mysql' ? snapshot.activeTerminal : undefined,
      connectedTerminals: snapshot.connectedTerminals.filter((terminal) => terminal.connectionKind === 'mysql'),
      knownTerminals: snapshot.knownTerminals.filter((terminal) => terminal.connectionKind === 'mysql')
    };
  }

  async mysqlSendInput(input: { terminalId?: string; input?: string }) {
    const target = this.resolveTerminal(input.terminalId);
    if (getAssetConnectionKind(target.asset) !== 'mysql') {
      throw new Error('A connected JumpServer MySQL terminal is required.');
    }
    const data = input.input ?? '';
    await this.requireConfirm(
      `Send input to JumpServer MySQL terminal on ${target.asset.name}?\n\n${previewInput(data)}`
    );
    target.write(data);
    return { terminalId: target.terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
  }

  async mysqlExecuteSql(input: { terminalId?: string; sql?: string; timeoutMs?: number; maxOutputBytes?: number }) {
    const sql = input.sql?.trim();
    if (!sql) {
      throw new Error('MySQL SQL cannot be empty.');
    }
    const target = this.resolveTerminal(input.terminalId);
    if (getAssetConnectionKind(target.asset) !== 'mysql') {
      throw new Error('A connected JumpServer MySQL terminal is required.');
    }
    if (!isReadOnlySql(sql)) {
      const ok = await this.dependencies.confirm(`Run state-changing MySQL SQL on ${target.asset.name}?\n\n${sql}`);
      if (!ok) {
        throw new Error('MySQL SQL execution was cancelled.');
      }
    }
    return await this.enqueueTerminal(target.terminalId, async () => {
      const liveTarget = this.resolveTerminal(target.terminalId);
      const output = this.requireOutput(liveTarget.terminalId);
      return await this.mysqlExecutor.execute({
        terminalId: liveTarget.terminalId,
        assetId: liveTarget.asset.id,
        assetName: liveTarget.asset.name,
        sql,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        write: liveTarget.write,
        output
      });
    });
  }

  private resolveTerminal(terminalId: string | undefined): ActiveTerminalContext {
    const targetId = terminalId === 'active' ? undefined : terminalId;
    const context = targetId
      ? this.dependencies.terminalContext.getContext(targetId)
      : this.dependencies.terminalContext.getActive();
    if (!context || !context.connected) {
      throw new Error('No matching connected JumpServer terminal is available. Connect a JumpServer asset first.');
    }
    return context;
  }

  private requireOutput(terminalId: string) {
    const output = this.dependencies.terminalContext.getOutputBuffer(terminalId);
    if (!output) {
      throw new Error('Terminal output capture is not available.');
    }
    return output;
  }

  private async requireConfirm(message: string): Promise<void> {
    if (!await this.dependencies.confirm(message)) {
      throw new Error('JumpServer operation was cancelled.');
    }
  }
}

function assetSummary(asset: CachedJumpServerAsset) {
  return {
    assetId: asset.id,
    name: asset.name,
    address: asset.address,
    platform: asset.platform,
    category: asset.category,
    type: asset.type,
    protocolNames: asset.protocolNames,
    connectionKind: getAssetConnectionKind(asset),
    nodePath: asset.nodePath
  };
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return 64 * 1024;
  }
  return Math.min(value, 256 * 1024);
}

function previewInput(value: string, maxChars = 400): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…(truncated)`;
}
