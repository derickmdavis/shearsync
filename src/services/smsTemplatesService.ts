import {
  appointmentReminderSmsTemplateTokens,
  isSmsTemplateType,
  smsTemplateDefinitions,
  smsTemplateTypes,
  type AppointmentReminderSmsTemplateInput,
  type AppointmentReminderSmsTemplateToken,
  type SmsTemplateDefinition,
  type SmsTemplateType
} from "../lib/smsTemplates";
import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

/** Printable ASCII messages at this limit fit in one GSM-7 SMS segment. */
export const MAX_SMS_TEMPLATE_LENGTH = 160;
const tokenPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

export interface SmsTemplateSettingsPayload {
  enabled?: boolean;
  customBody?: string | null;
}

export interface SmsTemplateSettings {
  templateType: SmsTemplateType;
  enabled: boolean;
  customBody: string | null;
  configured: boolean;
  updatedAt: string | null;
}

/** A null body means the account has explicitly disabled this template type. */
export interface AccountSmsTemplateRenderResult {
  enabled: boolean;
  body: string | null;
}

const normalizeText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) return value;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
};

const extractTokens = (template: string): string[] => [...template.matchAll(tokenPattern)].map((match) => match[1] ?? "");

const validateTemplate = (template: string): string => {
  if (!/^[\x20-\x7E]+$/.test(template)) throw new ApiError(400, "SMS template must use printable ASCII characters only");
  if (template.length > MAX_SMS_TEMPLATE_LENGTH) throw new ApiError(400, `SMS template must be ${MAX_SMS_TEMPLATE_LENGTH} characters or fewer`);
  const tokens = extractTokens(template);
  const unknown = tokens.find((token) => !(appointmentReminderSmsTemplateTokens as readonly string[]).includes(token));
  if (unknown) throw new ApiError(400, `Unsupported SMS template token: ${unknown}`);
  if (template.replace(tokenPattern, "").includes("{{") || template.replace(tokenPattern, "").includes("}}")) {
    throw new ApiError(400, "SMS template contains an invalid token");
  }
  if (!tokens.includes("businessName")) throw new ApiError(400, "SMS template must include {{businessName}} for business identity");
  if (!tokens.includes("clientFirstName")) throw new ApiError(400, "SMS appointment reminder template must include {{clientFirstName}}");
  if (!tokens.includes("appointmentDateTime")) throw new ApiError(400, "SMS appointment reminder template must include {{appointmentDateTime}}");
  if (!template.includes("Reply STOP to opt out.")) throw new ApiError(400, "SMS template must include Reply STOP to opt out.");
  return template;
};

const requireInput = (value: string, label: string): string => {
  const normalized = normalizeText(value);
  if (!normalized) throw new ApiError(400, `SMS appointment reminder requires ${label}`);
  return normalized;
};

const renderTemplate = (template: string, input: AppointmentReminderSmsTemplateInput): string => {
  const variables: Record<AppointmentReminderSmsTemplateToken, string> = {
    businessName: requireInput(input.businessName, "businessName"),
    clientFirstName: requireInput(input.clientFirstName, "clientFirstName"),
    appointmentDateTime: requireInput(input.appointmentDateTime, "appointmentDateTime"),
    serviceName: normalizeText(input.serviceName) ?? "",
    bookingManagementUrl: normalizeText(input.bookingManagementUrl) ?? ""
  };
  if (variables.bookingManagementUrl && !/^https?:\/\/[^\s]+$/i.test(variables.bookingManagementUrl)) {
    throw new ApiError(400, "SMS bookingManagementUrl must be an absolute HTTP(S) URL");
  }
  const rendered = template.replace(tokenPattern, (_match, token: string) => variables[token as AppointmentReminderSmsTemplateToken] ?? "")
    .replace(/\s+/g, " ").trim();
  if (!/^[\x20-\x7E]+$/.test(rendered)) throw new ApiError(400, "Rendered SMS must use printable ASCII characters only");
  if (rendered.length > MAX_SMS_TEMPLATE_LENGTH) throw new ApiError(400, `Rendered SMS must be ${MAX_SMS_TEMPLATE_LENGTH} characters or fewer`);
  return rendered;
};

const toSettings = (templateType: SmsTemplateType, row?: Row | null): SmsTemplateSettings => ({
  templateType,
  enabled: row?.enabled !== false,
  customBody: typeof row?.custom_body === "string" ? row.custom_body : null,
  configured: Boolean(row),
  updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null
});

/** SMS-only template rendering and account settings; it has no queue or provider dependency. */
export const smsTemplatesService = {
  listSupportedTypes(): readonly SmsTemplateType[] {
    return smsTemplateTypes;
  },

  getDefinition(type: SmsTemplateType): SmsTemplateDefinition {
    return smsTemplateDefinitions[type];
  },

  isSupportedType(value: unknown): value is SmsTemplateType {
    return isSmsTemplateType(value);
  },

  validateSettingsPayload(payload: SmsTemplateSettingsPayload): SmsTemplateSettingsPayload {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError(400, "SMS template settings payload is required");
    }
    if (!("enabled" in payload) && !("customBody" in payload)) {
      throw new ApiError(400, "Provide enabled or customBody when updating SMS template settings");
    }
    if (payload.customBody !== undefined && payload.customBody !== null && typeof payload.customBody !== "string") {
      throw new ApiError(400, "SMS template customBody must be a string or null");
    }
    const customBody = normalizeText(payload.customBody);
    if (customBody) validateTemplate(customBody);
    if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") throw new ApiError(400, "SMS template enabled must be a boolean");
    return {
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
      ...(customBody !== undefined ? { customBody } : {})
    };
  },

  renderAppointmentReminder(input: AppointmentReminderSmsTemplateInput, customBody?: string | null): string {
    const normalizedCustomBody = normalizeText(customBody);
    const definition = smsTemplateDefinitions.appointment_reminder;
    const template = normalizedCustomBody
      ? validateTemplate(normalizedCustomBody)
      : normalizeText(input.serviceName) ? definition.defaultBodies.withService : definition.defaultBodies.withoutService;
    return renderTemplate(template, input);
  },

  async renderAppointmentReminderForUser(
    userId: string,
    input: AppointmentReminderSmsTemplateInput
  ): Promise<AccountSmsTemplateRenderResult> {
    const settings = await this.getForUser(userId, "appointment_reminder");
    if (!settings.enabled) return { enabled: false, body: null };
    return {
      enabled: true,
      body: this.renderAppointmentReminder(input, settings.customBody)
    };
  },

  async getForUser(userId: string, templateType: SmsTemplateType = "appointment_reminder"): Promise<SmsTemplateSettings> {
    const { data, error } = await supabaseAdmin.from("sms_template_settings").select("*")
      .eq("user_id", userId).eq("template_type", templateType).maybeSingle();
    handleSupabaseError(error, "Unable to load SMS template settings");
    return toSettings(templateType, data as Row | null);
  },

  async upsertForUser(userId: string, templateType: SmsTemplateType, payload: SmsTemplateSettingsPayload): Promise<SmsTemplateSettings> {
    const normalized = this.validateSettingsPayload(payload);
    const { data, error } = await supabaseAdmin.rpc("upsert_sms_template_settings", {
      p_user_id: userId,
      p_template_type: templateType,
      p_has_enabled: "enabled" in normalized,
      p_enabled: normalized.enabled ?? null,
      p_has_custom_body: "customBody" in normalized,
      p_custom_body: normalized.customBody ?? null
    });
    handleSupabaseError(error, "Unable to save SMS template settings");
    return toSettings(templateType, requireFound(data as Row | null, "SMS template settings were not saved"));
  }
};
