import { z } from 'zod';

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\//i.test(value), 'baseUrl must start with http:// or https://');

export function bastionDisplayName(name: string, baseUrl: string): string {
  const trimmed = name.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    return new URL(baseUrl).hostname || baseUrl.replace(/\/+$/, '');
  } catch {
    return baseUrl.replace(/\/+$/, '') || 'JumpServer';
  }
}

export const jumpServerSettingsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    orgId: z.string().trim().optional().default(''),
    username: z.string().trim().min(1),
    verifyTls: z.boolean().default(true),
    updatedAt: z.number().int().nonnegative()
  })
  .strip();

export const jumpServerBastionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    baseUrl: httpUrlSchema,
    orgId: z.string().trim().optional().default(''),
    username: z.string().trim().min(1),
    verifyTls: z.boolean().default(true),
    updatedAt: z.number().int().nonnegative()
  })
  .strip()
  .transform((value) => ({
    ...value,
    name: bastionDisplayName(value.name, value.baseUrl)
  }));

export const jumpServerBastionListSchema = z.array(jumpServerBastionSchema);

export const cachedJumpServerAssetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    bastionId: z.string().min(1),
    address: z.string().optional().default(''),
    platform: z.string().optional().default(''),
    category: z.string().optional().default(''),
    type: z.string().optional().default(''),
    zoneName: z.string().optional().default(''),
    nodePath: z.array(z.string()).default([]),
    protocolNames: z.array(z.string()).default([]),
    raw: z.record(z.unknown()).default({})
  })
  .strict();

export const cachedJumpServerAssetListSchema = z.array(cachedJumpServerAssetSchema);

export const cachedJumpServerNodeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    bastionId: z.string().min(1),
    path: z.array(z.string().min(1)).default([]),
    assetIds: z.array(z.string().min(1)).default([]),
    raw: z.record(z.unknown()).default({})
  })
  .strict();

export const cachedJumpServerNodeListSchema = z.array(cachedJumpServerNodeSchema);

export type JumpServerSettings = z.infer<typeof jumpServerSettingsSchema>;
export type JumpServerBastion = z.infer<typeof jumpServerBastionSchema>;
export type CachedJumpServerAsset = z.infer<typeof cachedJumpServerAssetSchema>;
export type CachedJumpServerNode = z.infer<typeof cachedJumpServerNodeSchema>;

const SECRET_FIELD_PATTERN = /password|secret|token|cookie|authorization|private/i;

export function parseJumpServerSettings(value: unknown): JumpServerSettings {
  return jumpServerSettingsSchema.parse(value);
}

export function parseJumpServerBastion(value: unknown): JumpServerBastion {
  return jumpServerBastionSchema.parse(value);
}

export function parseJumpServerBastionList(value: unknown): JumpServerBastion[] {
  return jumpServerBastionListSchema.parse(value);
}

export function parseCachedJumpServerAsset(value: unknown): CachedJumpServerAsset {
  return cachedJumpServerAssetSchema.parse(value);
}

export function parseCachedJumpServerAssets(value: unknown): CachedJumpServerAsset[] {
  return cachedJumpServerAssetListSchema.parse(value);
}

export function parseCachedJumpServerNode(value: unknown): CachedJumpServerNode {
  return cachedJumpServerNodeSchema.parse(value);
}

export function parseCachedJumpServerNodes(value: unknown): CachedJumpServerNode[] {
  return cachedJumpServerNodeListSchema.parse(value);
}

export function sanitizeCachedAssetRaw(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      continue;
    }
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const nested = sanitizeCachedAssetRaw(rawValue);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
      continue;
    }
    result[key] = rawValue;
  }
  return result;
}
