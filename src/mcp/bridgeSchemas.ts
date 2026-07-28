import { z } from 'zod';

const terminalTargetFields = {
  terminalId: z.string().min(1).optional()
};

export const sendTerminalInputBridgeSchema = z
  .object({
    ...terminalTargetFields,
    input: z.string().min(1)
  })
  .strict();

export const runTerminalCommandBridgeSchema = z
  .object({
    ...terminalTargetFields,
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional()
  })
  .strict();

const sftpTargetFields = {
  connectionKey: z.string().min(1).optional(),
  terminalId: z.string().min(1).optional()
};

export const sftpListDirectoryBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1).optional()
  })
  .strict();

export const sftpPathBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1)
  })
  .strict();

export const sftpReadFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional()
  })
  .strict();

export const sftpWriteFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().optional()
  })
  .strict();

export const sftpCreateFileBridgeSchema = z
  .object({
    ...sftpTargetFields,
    path: z.string().min(1),
    content: z.string().optional()
  })
  .strict();

export const sftpRenameBridgeSchema = z
  .object({
    ...sftpTargetFields,
    oldPath: z.string().min(1),
    newPath: z.string().min(1)
  })
  .strict();

export const mysqlSendInputBridgeSchema = sendTerminalInputBridgeSchema;

export const mysqlExecuteSqlBridgeSchema = z
  .object({
    ...terminalTargetFields,
    sql: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional()
  })
  .strict();
