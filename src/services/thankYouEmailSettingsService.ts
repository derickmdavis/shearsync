import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";

export interface ThankYouEmailSettingsPayload {
  approvalRequired?: boolean;
  sendDelayHours?: number;
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
}

export interface ThankYouEmailTemplateSnapshot {
  subject_template?: string | null;
  custom_message_block?: string | null;
}

export const thankYouEmailTemplateTokens = [
  "client_name",
  "business_name",
  "business_phone",
  "business_email",
  "service_name",
  "appointment_date",
  "referral_url",
  "referral_code"
] as const;

export type ThankYouEmailTemplateToken = (typeof thankYouEmailTemplateTokens)[number];

const tokenPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const defaultSendDelayHours = 0;

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
    .filter((token) => !(thankYouEmailTemplateTokens as readonly string[]).includes(token));

  if (unknownTokens.length > 0) {
    throw new ApiError(400, `Unsupported thank you email template token: ${unknownTokens[0]}`);
  }
};

const normalizeSendDelayHours = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0 || value > 720) {
    throw new ApiError(400, "Send delay must be between 0 and 720 hours");
  }

  return value;
};

const validateSettingsPayload = (payload: ThankYouEmailSettingsPayload): ThankYouEmailSettingsPayload => {
  const subjectTemplate = normalizeTemplateText(payload.subjectTemplate);
  const customMessageBlock = normalizeTemplateText(payload.customMessageBlock);
  const sendDelayHours = normalizeSendDelayHours(payload.sendDelayHours);

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
    ...(sendDelayHours !== undefined ? { sendDelayHours } : {}),
    ...(subjectTemplate !== undefined ? { subjectTemplate } : {}),
    ...(customMessageBlock !== undefined ? { customMessageBlock } : {})
  };
};

const toApiSettings = (row?: Row | null) => ({
  approvalRequired: row?.approval_required !== false,
  sendDelayHours: Number(row?.send_delay_hours ?? defaultSendDelayHours),
  subjectTemplate: typeof row?.subject_template === "string" ? row.subject_template : null,
  customMessageBlock: typeof row?.custom_message_block === "string" ? row.custom_message_block : null,
  configured: Boolean(row),
  availableTokens: [...thankYouEmailTemplateTokens]
});

const toSnapshot = (row: Row | null): ThankYouEmailTemplateSnapshot | null => {
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

export const renderThankYouEmailTemplateString = (
  template: string,
  variables: Record<string, string>
): string =>
  template.replace(tokenPattern, (_match, token: string) =>
    (thankYouEmailTemplateTokens as readonly string[]).includes(token)
      ? variables[token as ThankYouEmailTemplateToken]
      : ""
  );

export const thankYouEmailSettingsService = {
  defaultSendDelayHours,
  availableTemplateTokens: [...thankYouEmailTemplateTokens],
  validateSettingsPayload,

  async getForUser(userId: string) {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const { data, error } = await supabaseAdmin
      .from("thank_you_email_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load thank you email settings");
    return toApiSettings(data as Row | null);
  },

  async getRawForUser(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("thank_you_email_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load thank you email settings");
    return data as Row | null;
  },

  async getSnapshotForUser(userId: string): Promise<ThankYouEmailTemplateSnapshot | null> {
    const row = await this.getRawForUser(userId);
    return toSnapshot(row);
  },

  async upsertForUser(userId: string, payload: ThankYouEmailSettingsPayload) {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const normalized = validateSettingsPayload(payload);
    const updates: Row = {};

    if ("approvalRequired" in normalized) {
      updates.approval_required = normalized.approvalRequired;
    }

    if ("sendDelayHours" in normalized) {
      updates.send_delay_hours = normalized.sendDelayHours;
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
        .from("thank_you_email_settings")
        .update(updates)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update thank you email settings");
      return toApiSettings(requireFound(data, "Thank you email settings not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("thank_you_email_settings")
      .insert({
        user_id: userId,
        approval_required: "approvalRequired" in normalized ? normalized.approvalRequired : true,
        send_delay_hours: "sendDelayHours" in normalized ? normalized.sendDelayHours : defaultSendDelayHours,
        subject_template: "subjectTemplate" in normalized ? normalized.subjectTemplate : null,
        custom_message_block: "customMessageBlock" in normalized ? normalized.customMessageBlock : null
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create thank you email settings");
    return toApiSettings(requireFound(data, "Thank you email settings were not created"));
  }
};
