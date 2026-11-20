import type { JumpServerAccountRef, JumpServerConnectionProtocol } from './types';

export const DEFAULT_CONNECT_OPTIONS = {
  charset: 'default',
  disableautohash: false,
  token_reusable: false,
  resolution: 'auto',
  backspaceAsCtrlH: false,
  appletConnectMethod: 'web',
  virtualappConnectMethod: 'web',
  reusable: false,
  rdp_connection_speed: 'auto'
} as const;

export const DEFAULT_MYSQL_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export const DEFAULT_REDIS_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export const DEFAULT_SFTP_CONNECT_OPTIONS = {
  token_reusable: false,
  disableautohash: false
} as const;

export function currentOsParam(): string {
  if (process.platform === 'win32') {
    return 'windows';
  }
  if (process.platform === 'darwin') {
    return 'macos';
  }
  return 'linux';
}

export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: JumpServerConnectionProtocol;
  connectMethod?: string;
}): Record<string, unknown> {
  if (input.protocol === 'mysql') {
    return buildMysqlConnectionTokenPayload(input);
  }
  if (input.protocol === 'redis') {
    return buildRedisConnectionTokenPayload(input);
  }
  if (input.protocol === 'sftp') {
    return buildSftpConnectionTokenPayload(input);
  }

  if (input.account.kind === 'alias') {
    const payload: Record<string, unknown> = {
      asset: input.assetId,
      account: input.account.alias,
      protocol: input.protocol,
      connect_method: input.connectMethod || 'web_cli',
      connect_options: DEFAULT_CONNECT_OPTIONS
    };
    if (input.account.alias === '@INPUT') {
      payload.input_username = input.account.inputUsername || input.account.username || '';
      payload.input_secret = input.account.inputSecret || '';
    }
    return payload;
  }

  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: input.connectMethod || 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}

export function buildSftpConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  connectMethod?: string;
}): Record<string, unknown> {
  if (input.account.kind === 'alias') {
    const payload: Record<string, unknown> = {
      asset: input.assetId,
      account: input.account.alias,
      protocol: 'sftp',
      connect_method: input.connectMethod || 'web_sftp',
      connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
    };
    if (input.account.alias === '@INPUT') {
      payload.input_username = input.account.inputUsername || input.account.username || '';
      payload.input_secret = input.account.inputSecret || '';
    }
    return payload;
  }

  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: 'sftp',
    input_username: input.account.username,
    input_secret: '',
    connect_method: input.connectMethod || 'web_sftp',
    connect_options: DEFAULT_SFTP_CONNECT_OPTIONS
  };
}

export function buildMysqlConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  connectMethod?: string;
}): Record<string, unknown> {
  if (input.account.kind === 'alias') {
    const payload: Record<string, unknown> = {
      asset: input.assetId,
      account: input.account.alias,
      protocol: 'mysql',
      connect_method: input.connectMethod || 'db_client',
      connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
    };
    if (input.account.alias === '@INPUT') {
      payload.input_username = input.account.inputUsername || input.account.username || '';
      payload.input_secret = input.account.inputSecret || '';
    }
    return payload;
  }

  return {
    asset: input.assetId,
    account: input.account.alias || input.account.id,
    protocol: 'mysql',
    input_username: input.account.username,
    input_secret: '',
    connect_method: input.connectMethod || 'db_client',
    connect_options: DEFAULT_MYSQL_CONNECT_OPTIONS
  };
}

export function buildRedisConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  connectMethod?: string;
}): Record<string, unknown> {
  if (input.account.kind === 'alias') {
    const payload: Record<string, unknown> = {
      asset: input.assetId,
      account: input.account.alias,
      protocol: 'redis',
      connect_method: input.connectMethod || 'db_client',
      connect_options: DEFAULT_REDIS_CONNECT_OPTIONS
    };
    if (input.account.alias === '@INPUT') {
      payload.input_username = input.account.inputUsername || input.account.username || '';
      payload.input_secret = input.account.inputSecret || '';
    }
    return payload;
  }

  return {
    asset: input.assetId,
    account: input.account.alias || input.account.id,
    protocol: 'redis',
    input_username: input.account.username,
    input_secret: '',
    connect_method: input.connectMethod || 'db_client',
    connect_options: DEFAULT_REDIS_CONNECT_OPTIONS
  };
}
