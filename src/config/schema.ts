import { z } from 'zod';

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\//i.test(value), 'baseUrl must start with http:// or https://');

export const jumpServerSettingsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    orgId: z.string().trim().optional().default(''),
    username: z.string().trim().min(1),
    verifyTls: z.boolean().default(true),
    connectTimeout: z.number().int().min(1).max(120).default(30),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

export const cachedJumpServerAssetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
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

export type JumpServerSettings = z.infer<typeof jumpServerSettingsSchema>;
export type CachedJumpServerAsset = z.infer<typeof cachedJumpServerAssetSchema>;

const SECRET_FIELD_PATTERN = /password|secret|token|cookie|authorization|private/i;

export function parseJumpServerSettings(value: unknown): JumpServerSettings {
  return jumpServerSettingsSchema.parse(value);
}

export function parseCachedJumpServerAsset(value: unknown): CachedJumpServerAsset {
  return cachedJumpServerAssetSchema.parse(value);
}

export function parseCachedJumpServerAssets(value: unknown): CachedJumpServerAsset[] {
  return cachedJumpServerAssetListSchema.parse(value);
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
