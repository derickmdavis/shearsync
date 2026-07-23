import { z } from "zod";
import {
  APP_CONTENT_CATEGORIES,
  APP_CONTENT_KEY_PATTERN,
  APP_CONTENT_NAMESPACE_PATTERN,
  APP_CONTENT_PLACEHOLDER_NAME_PATTERN,
  normalizeAppContentLocale,
  normalizeSupportedAppContentLocale
} from "../lib/appContent";

const localeSchema = z.string().trim().min(1).max(20).transform((value, context) => {
  try {
    return normalizeSupportedAppContentLocale(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only en-US is currently supported" });
    return z.NEVER;
  }
});

const requestedLocaleSchema = z.string().trim().min(1).max(20).transform((value, context) => {
  try {
    return normalizeAppContentLocale(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Locale must use a language or language-region tag" });
    return z.NEVER;
  }
});

export const appContentKeySchema = z.string().trim().min(3).max(160).regex(
  APP_CONTENT_KEY_PATTERN,
  "Content keys must be lowercase semantic dotted keys"
);

const appContentNamespaceSchema = z.string().trim().min(1).max(80).regex(
  APP_CONTENT_NAMESPACE_PATTERN,
  "Namespace must use lowercase letters, numbers, and underscores"
);

const appContentPlaceholderSchema = z.string().trim().min(1).max(80).regex(
  APP_CONTENT_PLACEHOLDER_NAME_PATTERN,
  "Placeholder names must use lower camel case"
);

const optionalPlainTextSchema = z.string().max(2_000).nullable().optional();

export const appContentDefinitionKeyParamSchema = z.object({
  key: appContentKeySchema
});

export const createAppContentDefinitionSchema = z.object({
  key: appContentKeySchema,
  namespace: appContentNamespaceSchema,
  category: z.enum(APP_CONTENT_CATEGORIES),
  description: z.string().trim().min(1).max(500),
  allowed_placeholders: z.array(appContentPlaceholderSchema).max(20).default([])
    .refine((values) => new Set(values).size === values.length, "Placeholder names must be unique"),
  max_length: z.number().int().min(1).max(2_000).default(500),
  multiline_allowed: z.boolean().default(false),
  fallback_required: z.boolean().default(true),
  developer_notes: optionalPlainTextSchema
}).strict().superRefine((value, context) => {
  if (value.key.split(".")[0] !== value.namespace) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["namespace"],
      message: "Namespace must match the first segment of the content key"
    });
  }
});

export const updateAppContentDefinitionSchema = z.object({
  category: z.enum(APP_CONTENT_CATEGORIES).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  allowed_placeholders: z.array(appContentPlaceholderSchema).max(20)
    .refine((values) => new Set(values).size === values.length, "Placeholder names must be unique").optional(),
  max_length: z.number().int().min(1).max(2_000).optional(),
  multiline_allowed: z.boolean().optional(),
  is_active: z.boolean().optional(),
  fallback_required: z.boolean().optional(),
  developer_notes: optionalPlainTextSchema
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one definition field is required" });
  }
});

export const listAppContentDefinitionsQuerySchema = z.object({
  namespace: appContentNamespaceSchema.optional(),
  status: z.enum(["active", "inactive", "all"]).default("all"),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
});

export const appContentDraftQuerySchema = z.object({
  locale: localeSchema.default("en-US")
});

export const appContentBundleQuerySchema = z.object({
  locale: requestedLocaleSchema.default("en-US")
});

export const listAppContentDraftsQuerySchema = z.object({
  locale: localeSchema.default("en-US"),
  namespace: appContentNamespaceSchema.optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
});

export const putAppContentDraftSchema = z.object({
  locale: localeSchema.default("en-US"),
  value: z.string().min(1).max(2_000),
  expected_draft_version: z.number().int().positive().nullable()
}).strict();

export const validateAppContentDraftsSchema = z.object({
  locale: localeSchema.default("en-US"),
  key: appContentKeySchema.optional()
}).strict();

export const publishAppContentSchema = z.object({
  locale: localeSchema.default("en-US"),
  expected_active_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();

export const rollbackAppContentSchema = z.object({
  locale: localeSchema.default("en-US"),
  revision_id: z.string().uuid(),
  expected_active_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();

export const listAppContentRevisionsQuerySchema = z.object({
  locale: localeSchema.default("en-US"),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
});

export const appContentRevisionIdParamSchema = z.object({
  id: z.string().uuid()
});

export const listAppContentAuditQuerySchema = z.object({
  locale: localeSchema.optional(),
  key: appContentKeySchema.optional(),
  revision_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
});
