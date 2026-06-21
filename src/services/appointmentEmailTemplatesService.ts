import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import type { AppointmentEmailType } from "./appointmentEmailEventsService";

export const customizableAppointmentEmailTypes = [
  "appointment_scheduled",
  "appointment_pending",
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder",
  "rebooking_prompt",
  "birthday_reminder",
  "thank_you_email"
] as const;

export type CustomizableAppointmentEmailType = (typeof customizableAppointmentEmailTypes)[number];

export interface AppointmentEmailTemplatePayload {
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
}

export interface AppointmentEmailTemplateSnapshot {
  subject_template?: string | null;
  custom_message_block?: string | null;
}

const availableTemplateTokens = [
  "client_name",
  "service_name",
  "appointment_time",
  "business_name",
  "business_phone",
  "business_email",
  "manage_appointment_url",
  "last_service_name",
  "last_appointment_date",
  "rebook_url",
  "birthday",
  "appointment_date",
  "referral_url",
  "referral_code"
] as const;

type TemplateToken = (typeof availableTemplateTokens)[number];

const tokenPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

const isCustomizableAppointmentEmailType = (value: string): value is CustomizableAppointmentEmailType =>
  (customizableAppointmentEmailTypes as readonly string[]).includes(value);

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
    .filter((token) => !(availableTemplateTokens as readonly string[]).includes(token));

  if (unknownTokens.length > 0) {
    throw new ApiError(400, `Unsupported email template token: ${unknownTokens[0]}`);
  }
};

const validateTemplatePayload = (payload: AppointmentEmailTemplatePayload): AppointmentEmailTemplatePayload => {
  const subjectTemplate = normalizeTemplateText(payload.subjectTemplate);
  const customMessageBlock = normalizeTemplateText(payload.customMessageBlock);

  if (subjectTemplate && subjectTemplate.length > 160) {
    throw new ApiError(400, "Subject template must be 160 characters or fewer");
  }

  if (customMessageBlock && customMessageBlock.length > 4000) {
    throw new ApiError(400, "Custom message block must be 4000 characters or fewer");
  }

  validateTemplateTokens(subjectTemplate);
  validateTemplateTokens(customMessageBlock);

  return {
    ...(subjectTemplate !== undefined ? { subjectTemplate } : {}),
    ...(customMessageBlock !== undefined ? { customMessageBlock } : {})
  };
};

const toApiTemplate = (emailType: CustomizableAppointmentEmailType, row?: Row | null) => ({
  emailType,
  subjectTemplate: typeof row?.subject_template === "string" ? row.subject_template : null,
  customMessageBlock: typeof row?.custom_message_block === "string" ? row.custom_message_block : null,
  configured: Boolean(row),
  availableTokens: [...availableTemplateTokens]
});

const toSnapshot = (row: Row | null): AppointmentEmailTemplateSnapshot | null => {
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

export const renderEmailTemplateString = (
  template: string,
  variables: Record<TemplateToken, string>
): string =>
  template.replace(tokenPattern, (_match, token: string) =>
    (availableTemplateTokens as readonly string[]).includes(token)
      ? variables[token as TemplateToken]
      : ""
  );

export const appointmentEmailTemplatesService = {
  availableTemplateTokens: [...availableTemplateTokens],
  customizableAppointmentEmailTypes: [...customizableAppointmentEmailTypes],
  isCustomizableAppointmentEmailType,
  validateTemplatePayload,

  async getForUser(userId: string) {
    const { data, error } = await supabaseAdmin
      .from("appointment_email_templates")
      .select("*")
      .eq("user_id", userId);

    handleSupabaseError(error, "Unable to load appointment email templates");
    const rowsByType = new Map(
      ((data ?? []) as Row[])
        .filter((row) => typeof row.email_type === "string" && isCustomizableAppointmentEmailType(row.email_type))
        .map((row) => [row.email_type as CustomizableAppointmentEmailType, row])
    );

    return customizableAppointmentEmailTypes.map((emailType) => toApiTemplate(emailType, rowsByType.get(emailType)));
  },

  async getOneForUser(userId: string, emailType: string) {
    if (!isCustomizableAppointmentEmailType(emailType)) {
      throw new ApiError(400, "Unsupported appointment email template type");
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_email_templates")
      .select("*")
      .eq("user_id", userId)
      .eq("email_type", emailType)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment email template");
    return toApiTemplate(emailType, data as Row | null);
  },

  async getSnapshotForUser(userId: string, emailType: AppointmentEmailType): Promise<AppointmentEmailTemplateSnapshot | null> {
    if (!isCustomizableAppointmentEmailType(emailType)) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_email_templates")
      .select("subject_template, custom_message_block")
      .eq("user_id", userId)
      .eq("email_type", emailType)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment email template");
    return toSnapshot(data as Row | null);
  },

  async upsertForUser(userId: string, emailType: string, payload: AppointmentEmailTemplatePayload) {
    if (!isCustomizableAppointmentEmailType(emailType)) {
      throw new ApiError(400, "Unsupported appointment email template type");
    }

    const normalized = validateTemplatePayload(payload);
    const updates: Row = {};

    if ("subjectTemplate" in normalized) {
      updates.subject_template = normalized.subjectTemplate;
    }

    if ("customMessageBlock" in normalized) {
      updates.custom_message_block = normalized.customMessageBlock;
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("appointment_email_templates")
      .select("*")
      .eq("user_id", userId)
      .eq("email_type", emailType)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to load appointment email template");

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("appointment_email_templates")
        .update(updates)
        .eq("user_id", userId)
        .eq("email_type", emailType)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update appointment email template");
      return toApiTemplate(emailType, requireFound(data, "Appointment email template not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_email_templates")
      .insert({
        user_id: userId,
        email_type: emailType,
        subject_template: "subjectTemplate" in normalized ? normalized.subjectTemplate : null,
        custom_message_block: "customMessageBlock" in normalized ? normalized.customMessageBlock : null
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create appointment email template");
    return toApiTemplate(emailType, requireFound(data, "Appointment email template was not created"));
  },

  async resetForUser(userId: string, emailType: string) {
    if (!isCustomizableAppointmentEmailType(emailType)) {
      throw new ApiError(400, "Unsupported appointment email template type");
    }

    const { error } = await supabaseAdmin
      .from("appointment_email_templates")
      .delete()
      .eq("user_id", userId)
      .eq("email_type", emailType);

    handleSupabaseError(error, "Unable to reset appointment email template");
    return toApiTemplate(emailType);
  }
};
