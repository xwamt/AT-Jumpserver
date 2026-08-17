import type { JumpServerConfigManager } from '../config/JumpServerConfigManager';
import type { CachedJumpServerAsset } from '../config/schema';
import { getAssetConnectionKind } from '../jumpserver/connectionTypes';
import type { JumpServerSftpManager } from '../sftp/JumpServerSftpManager';
import type { JumpServerSftpEntry } from '../sftp/SftpTypes';
import type { ActiveTerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatCommandConfirmMessage } from '../utils/commandPreview';
import { isBlockingRedisCommand, isReadOnlyRedisCommand } from './RedisSafety';
import { isReadOnlySql } from './SqlSafety';
import { MysqlCliExecutor, RedisCliExecutor, ShellTerminalExecutor } from './TerminalExecutors';

export interface JumpServerAgentToolServiceDependencies {
  configManager: Pick<JumpServerConfigManager, 'listCachedAssets'>;
  terminalContext: TerminalContextRegistry;
  sftp: Pick<JumpServerSftpManager,
    | 'listDirectory' | 'stat' | 'readFile' | 'writeFile' | 'createFile' | 'mkdir' | 'rename' | 'deleteEntry'
    | 'getConnectionAsset'
  >;
  confirm(message: string): Promise<boolean>;
  shellExecutor?: ShellTerminalExecutor;
  mysqlExecutor?: MysqlCliExecutor;
}

export class JumpServerAgentToolService {
  private readonly shellExecutor: ShellTerminalExecutor;
  private readonly mysqlExecutor: MysqlCliExecutor;
  private readonly redisExecutor = new RedisCliExecutor();
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

  async listAssets(input: { limit?: number; offset?: number; search?: string } = {}) {
    const assets = await this.dependencies.configManager.listCachedAssets();
    const search = input.search?.trim().toLowerCase();
    const filtered = search
      ? assets.filter((asset) => {
          const haystack = [asset.id, asset.name, asset.address, ...(asset.nodePath ?? [])].join(' ').toLowerCase();
          return haystack.includes(search);
        })
      : assets;
    const limit = clampPositiveInteger(input.limit, DEFAULT_LIST_ASSETS_LIMIT, MAX_LIST_ASSETS_LIMIT);
    const offset = Number.isInteger(input.offset) && (input.offset as number) >= 0 ? (input.offset as number) : 0;
    const page = filtered.slice(offset, offset + limit);
    return {
      assets: page.map(assetSummary),
      total: filtered.length,
      offset,
      limit,
      truncated: offset + page.length < filtered.length
    };
  }

  async getTerminalContext() {
    return this.dependencies.terminalContext.getSnapshot();
  }

  async sendTerminalInput(input: { terminalId?: string; input?: string }) {
    const target = this.resolveTerminal(input.terminalId);
    const data = input.input ?? '';
    await this.requireConfirm(formatCommandConfirmMessage({
      action: 'Send input to JumpServer terminal',
      target: formatAssetTarget(target.asset),
      command: data
    }));
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
    const confirmed = await this.dependencies.confirm(formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: formatAssetTarget(target.asset),
      command
    }));
    if (!confirmed) {
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

  async sftpListDirectory(input: {
    connectionKey?: string;
    terminalId?: string;
    path?: string;
    maxEntries?: number;
  }) {
    const entries = await this.dependencies.sftp.listDirectory(input.path, connectionKeyOf(input));
    const maxEntries = clampPositiveInteger(
      input.maxEntries,
      DEFAULT_SFTP_LIST_MAX_ENTRIES,
      MAX_SFTP_LIST_MAX_ENTRIES
    );
    const truncated = entries.length > maxEntries;
    return {
      path: input.path,
      entries: truncated ? entries.slice(0, maxEntries) : entries,
      truncated,
      total: entries.length
    };
  }

  async sftpStatPath(input: { connectionKey?: string; terminalId?: string; path: string }) {
    return await this.dependencies.sftp.stat(input.path, connectionKeyOf(input));
  }

  async sftpReadFile(input: { connectionKey?: string; terminalId?: string; path: string; maxBytes?: number }) {
    const maxBytes = clampReadBytes(input.maxBytes);
    const buffer = await this.dependencies.sftp.readFile(input.path, maxBytes, connectionKeyOf(input));
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
    await this.requireConfirm(`Write JumpServer SFTP file ${input.path} on ${this.sftpTarget(input)}?`);
    await this.dependencies.sftp.writeFile(input.path, Buffer.from(input.content, 'utf8'), connectionKeyOf(input));
    return { path: input.path, bytesWritten: Buffer.byteLength(input.content, 'utf8') };
  }

  async sftpCreateFile(input: { connectionKey?: string; terminalId?: string; path: string; content?: string }) {
    await this.requireConfirm(`Create JumpServer SFTP file ${input.path} on ${this.sftpTarget(input)}?`);
    if (input.content === undefined) {
      await this.dependencies.sftp.createFile(input.path, connectionKeyOf(input));
    } else {
      await this.dependencies.sftp.writeFile(input.path, Buffer.from(input.content, 'utf8'), connectionKeyOf(input));
    }
    return { path: input.path };
  }

  async sftpCreateDirectory(input: { connectionKey?: string; terminalId?: string; path: string }) {
    await this.requireConfirm(`Create JumpServer SFTP directory ${input.path} on ${this.sftpTarget(input)}?`);
    await this.dependencies.sftp.mkdir(input.path, connectionKeyOf(input));
    return { path: input.path };
  }

  async sftpRename(input: { connectionKey?: string; terminalId?: string; oldPath: string; newPath: string }) {
    await this.requireConfirm(
      `Rename JumpServer SFTP path ${input.oldPath} to ${input.newPath} on ${this.sftpTarget(input)}?`
    );
    await this.dependencies.sftp.rename(input.oldPath, input.newPath, connectionKeyOf(input));
    return { oldPath: input.oldPath, newPath: input.newPath };
  }

  async sftpDelete(input: { connectionKey?: string; terminalId?: string; path: string; type?: JumpServerSftpEntry['type'] }) {
    await this.requireConfirm(`Delete JumpServer SFTP path ${input.path} on ${this.sftpTarget(input)}?`);
    await this.dependencies.sftp.deleteEntry({
      name: input.path.split('/').filter(Boolean).pop() || input.path,
      path: input.path,
      type: input.type ?? 'file'
    }, connectionKeyOf(input));
    return { path: input.path, deleted: true };
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
      const ok = await this.dependencies.confirm(formatCommandConfirmMessage({
        action: 'Run state-changing MySQL SQL',
        target: formatAssetTarget(target.asset),
        command: sql
      }));
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

  async redisExecuteCommand(input: {
    terminalId?: string;
    command?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }) {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Redis command cannot be empty.');
    }
    if (/[\r\n]/.test(command)) {
      throw new Error('Only a single Redis command is supported per jumpserver_redis_execute_command call.');
    }
    if (isBlockingRedisCommand(command)) {
      throw new Error(
        'Blocking Redis commands are not supported via jumpserver_redis_execute_command. ' +
        'Use the open Redis terminal with jumpserver_send_terminal_input instead.'
      );
    }
    const target = this.resolveTerminal(input.terminalId);
    if (getAssetConnectionKind(target.asset) !== 'redis') {
      throw new Error('A connected JumpServer Redis terminal is required.');
    }
    if (!isReadOnlyRedisCommand(command)) {
      const ok = await this.dependencies.confirm(formatCommandConfirmMessage({
        action: 'Run state-changing Redis command',
        target: formatAssetTarget(target.asset),
        command
      }));
      if (!ok) {
        throw new Error('Redis command execution was cancelled.');
      }
    }
    return await this.enqueueTerminal(target.terminalId, async () => {
      const liveTarget = this.resolveTerminal(target.terminalId);
      const output = this.requireOutput(liveTarget.terminalId);
      return await this.redisExecutor.execute({
        terminalId: liveTarget.terminalId,
        assetId: liveTarget.asset.id,
        assetName: liveTarget.asset.name,
        command,
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

  private sftpTarget(input: { connectionKey?: string; terminalId?: string }): string {
    return formatAssetTarget(this.dependencies.sftp.getConnectionAsset(connectionKeyOf(input)));
  }

  private async requireConfirm(message: string): Promise<void> {
    if (!await this.dependencies.confirm(message)) {
      throw new Error('JumpServer operation was cancelled.');
    }
  }
}

function connectionKeyOf(input: { connectionKey?: string; terminalId?: string }): string | undefined {
  return input.connectionKey ?? input.terminalId;
}

export function formatAssetTarget(asset: Pick<CachedJumpServerAsset, 'name' | 'address'> | undefined): string {
  if (!asset) {
    return 'an unidentified JumpServer connection';
  }
  return asset.address ? `${asset.name} (${asset.address})` : asset.name;
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

const DEFAULT_LIST_ASSETS_LIMIT = 200;
const MAX_LIST_ASSETS_LIMIT = 500;
const DEFAULT_SFTP_LIST_MAX_ENTRIES = 500;
const MAX_SFTP_LIST_MAX_ENTRIES = 5_000;

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return 64 * 1024;
  }
  return Math.min(value, 256 * 1024);
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}