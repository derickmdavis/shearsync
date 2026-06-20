import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";

export interface RebookNudgeSettingsPayload {
  approvalRequired?: boolean;
  defaultRebookIntervalDays?: number;
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
}

export interface RebookNudgeTemplateSnapshot {
  subject_template?: string | null;
  custom_message_block?: string | null;
}

export const rebookNudgeTemplateTokens = [
  "client_name",
  "business_name",
  "business_phone",
  "business_email",
  "last_service_name",
  "last_appointment_date",
  "rebook_url"
] as const;

export type RebookNudgeTemplateToken = (typeof rebookNudgeTemplateTokens)[number];

const tokenPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const defaultIntervalDays = 90;

const normalizeTemplateText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractTemplateTokens = (value: string | null | undefined): string[] => {
  if (!value) {
    return [];
  }

  return [...value.matchAll(tokenPattern)].map((match) => match[1] ?? "");
};

const validateTemplateTokens = (value: string | null | undefined): void => {
  const unknownTokens = extractTemplateTokens(value)
    .filter((token) => !(rebookNudgeTemplateTokens as readonly string[]).includes(token));

  if (unknownTokens.length > 0) {
    throw new ApiError(400, `Unsupported rebook nudge template token: ${unknownTokens[0]}`);
  }
};

const normalizeIntervalDays = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1 || value > 730) {
    throw new ApiError(400, "Default rebook interval must be between 1 and 730 days");
  }

  return value;
};

const validateSettingsPayload = (payload: RebookNudgeSettingsPayload): RebookNudgeSettingsPayload => {
  const subjectTemplate = normalizeTemplateText(payload.subjectTemplate);
  const customMessageBlock = normalizeTemplateText(payload.customMessageBlock);
  const defaultRebookIntervalDays = normalizeIntervalDays(payload.defaultRebookIntervalDays);

  if (subjectTemplate && subjectTemplate.length > 160) {
    throw new ApiError(400, "Subject template must be 160 characters or fewer");
  }

  if (customMessageBlock && customMessageBlock.length > 4000) {
    throw new ApiError(400, "Custom message block must be 4000 characters or fewer");
  }

  validateTemplateTokens(subjectTemplate);
  validateTemplateTokens(customMessageBlock);

  return {
    ...(payload.approvalRequired !== undefined ? { approvalRequired: payload.approvalRequired } : {}),
    ...(defaultRebookIntervalDays !== undefined ? { defaultRebookIntervalDays } : {}),
    ...(subjectTemplate !== undefined ? { subjectTemplate } : {}),
    ...(customMessageBlock !== undefined ? { customMessageBlock } : {})
  };
};

const toApiSettings = (row?: Row | null) => ({
  approvalRequired: row?.approval_required !== false,
  defaultRebookIntervalDays: Number(row?.default_rebook_interval_days ?? defaultIntervalDays),
  subjectTemplate: typeof row?.subject_template === "string" ? row.subject_template : null,
  customMessageBlock: typeof row?.custom_message_block === "string" ? row.custom_message_block : null,
  configured: Boolean(row),
  availableTokens: [...rebookNudgeTemplateTokens]
});

const toSnapshot = (row: Row | null): RebookNudgeTemplateSnapshot | null => {
  if (!row) {
    return null;
  }

  const subjectTemplate = normalizeTemplateText(row.subject_template as string | null | undefined);
  const customMessageBlock = normalizeTemplateText(row.custom_message_block as string | null | undefined);

  if (!subjectTemplate && !customMessageBlock) {
    return null;
  }

  return {
    ...(subjectTemplate ? { subject_template: subjectTemplate } : {}),
    ...(customMessageBlock ? { custom_message_block: customMessageBlock } : {})
  };
};

export const renderRebookNudgeTemplateString = (
  template: string,
  variables: Record<string, string>
): string =>
  template.replace(tokenPattern, (_match, token: string) =>
    (rebookNudgeTemplateTokens as readonly string[]).includes(token)
      ? variables[token as RebookNudgeTemplateToken]
      : ""
  );

export const rebookNudgeSettingsService = {
  defaultIntervalDays,
  availableTemplateTokens: [...rebookNudgeTemplateTokens],
  validateSettingsPayload,

  async getForUser(userId: string) {
    await entitlementsService.assertFeatureAllowed(userId, "rebookNudges");

    const { data, error } = await supabaseAdmin
      .from("rebook_nudge_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load rebook nudge settings");
    return toApiSettings(data as Row | null);
  },

  async getRawForUser(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudge_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load rebook nudge settings");
    return data as Row | null;
  },

  async getSnapshotForUser(userId: string): Promise<RebookNudgeTemplateSnapshot | null> {
    const row = await this.getRawForUser(userId);
    return toSnapshot(row);
  },

  async upsertForUser(userId: string, payload: RebookNudgeSettingsPayload) {
    await entitlementsService.assertFeatureAllowed(userId, "rebookNudges");

    const normalized = validateSettingsPayload(payload);
    const updates: Row = {};

    if ("approvalRequired" in normalized) {
      updates.approval_required = normalized.approvalRequired;
    }

    if ("defaultRebookIntervalDays" in normalized) {
      updates.default_rebook_interval_days = normalized.defaultRebookIntervalDays;
    }

    if ("subjectTemplate" in normalized) {
      updates.subject_template = normalized.subjectTemplate;
    }

    if ("customMessageBlock" in normalized) {
      updates.custom_message_block = normalized.customMessageBlock;
    }

    const existing = await this.getRawForUser(userId);

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("rebook_nudge_settings")
        .update(updates)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update rebook nudge settings");
      return toApiSettings(requireFound(data, "Rebook nudge settings not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("rebook_nudge_settings")
      .insert({
        user_id: userId,
        approval_required: "approvalRequired" in normalized ? normalized.approvalRequired : true,
        default_rebook_interval_days: "defaultRebookIntervalDays" in normalized
          ? normalized.defaultRebookIntervalDays
          : defaultIntervalDays,
        subject_template: "subjectTemplate" in normalized ? normalized.subjectTemplate : null,
        custom_message_block: "customMessageBlock" in normalized ? normalized.customMessageBlock : null
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create rebook nudge settings");
    return toApiSettings(requireFound(data, "Rebook nudge settings were not created"));
  }
};
