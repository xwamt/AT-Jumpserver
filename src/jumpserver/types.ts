export interface JumpServerSettingsWithPassword {
  baseUrl: string;
  orgId: string;
  username: string;
  password: string;
  verifyTls: boolean;
}

export interface JumpServerEndpoint {
  host?: string;
  https_port?: number;
  http_port?: number;
}

export type JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'redis' | 'sftp' | 'rdp' | (string & {});

export const JUMPSERVER_ALIAS_ACCOUNTS = ['@USER', '@INPUT', '@ANON', '@ALL', '@SPEC'] as const;
export type JumpServerAliasAccount = typeof JUMPSERVER_ALIAS_ACCOUNTS[number];

export interface JumpServerManagedAccountRef {
  kind: 'managed';
  id: string;
  alias?: string;
  username: string;
  hasSecret?: boolean;
}

export interface JumpServerAliasAccountRef {
  kind: 'alias';
  alias: JumpServerAliasAccount;
  id?: string;
  username?: string;
  hasSecret?: boolean;
  inputUsername?: string;
  inputSecret?: string;
}

export type JumpServerAccountRef =
  | JumpServerManagedAccountRef
  | JumpServerAliasAccountRef
  | { id: string; alias?: string; username: string; hasSecret?: boolean; kind?: 'managed' };

export type TerminalConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface TerminalEvents {
  output(data: Buffer): void;
  status(message: string, state?: TerminalConnectionState): void;
  error(error: unknown): void;
}

export interface KokoControlMessage {
  id?: string;
  type?: string;
  data?: unknown;
}
