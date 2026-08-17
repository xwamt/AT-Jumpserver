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

export type JumpServerConnectionProtocol = 'ssh' | 'mysql' | 'redis' | 'sftp';

export interface JumpServerAccountRef {
  id: string;
  alias?: string;
  username: string;
  hasSecret?: boolean;
}

export interface TerminalEvents {
  output(data: Buffer): void;
  status(message: string): void;
  error(error: unknown): void;
}

export interface KokoControlMessage {
  id?: string;
  type?: string;
  data?: unknown;
}
