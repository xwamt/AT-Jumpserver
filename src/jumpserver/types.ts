export interface JumpServerSettingsWithPassword {
  baseUrl: string;
  orgId: string;
  username: string;
  password: string;
  verifyTls: boolean;
  connectTimeout: number;
}

export interface JumpServerEndpoint {
  host?: string;
  https_port?: number;
  http_port?: number;
}

export interface JumpServerAccountRef {
  id: string;
  username: string;
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
