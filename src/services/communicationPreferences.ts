import { ApiError } from "../lib/errors";
import {
  type CommunicationChannel,
  type ConsentSource,
  type MessageType,
  normalizeContact,
  normalizeEmail,
  normalizePhone
} from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { communicationEventsService } from "./communicationEvents";

interface PreferenceContactOptions {
  userId: string;
  clientId?: string | null;
  stylistId?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface CanSendCommunicationOptions {
  userId: string;
  clientId?: string | null;
  stylistId?: string | null;
  channel: CommunicationChannel;
  to?: string | null;
  messageType: MessageType;
}

interface CanSendCommunicationResult {
  canSend: boolean;
  reason?: "missing_contact" | "missing_sms_consent" | "opted_out" | "disabled";
  preference?: Row;
  toNormalized?: string;
}

interface OptInSmsOptions {
  userId: string;
  clientId?: string | null;
  stylistId?: string | null;
  phone: string;
  source: ConsentSource;
  consentText: string;
  enableTransactional?: boolean;
  enableReminders?: boolean;
  enableMarketing?: boolean;
  enableRebooking?: boolean;
}

const isTruthy = (value: unknown): boolean => value === true;
const isMissing = (value: unknown): boolean => value === null || value === undefined || value === "";

const findPreferenceByContact = async (
  userId: string,
  emailNormalized?: string | null,
  phoneNormalized?: string | null
): Promise<Row | null> => {
  if (emailNormalized) {
    const { data, error } = await supabaseAdmin
      .from("client_communication_preferences")
      .select("*")
      .eq("user_id", userId)
      .eq("email_normalized", emailNormalized)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load communication preference");
    if (data) {
      return data as Row;
    }
  }

  if (phoneNormalized) {
    const { data, error } = await supabaseAdmin
      .from("client_communication_preferences")
      .select("*")
      .eq("user_id", userId)
      .eq("phone_normalized", phoneNormalized)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load communication preference");
    return data as Row | null;
  }

  return null;
};

const updateMissingPreferenceFields = async (
  preference: Row,
  options: PreferenceContactOptions,
  emailNormalized: string | null,
  phoneNormalized: string | null
): Promise<Row> => {
  const updates: Row = {};

  if (options.clientId && isMissing(preference.client_id)) {
    updates.client_id = options.clientId;
  }

  if (options.stylistId && isMissing(preference.stylist_id)) {
    updates.stylist_id = options.stylistId;
  }

  if (options.email && emailNormalized && isMissing(preference.email)) {
    updates.email = options.email;
    updates.email_normalized = emailNormalized;
  }

  if (options.phone && phoneNormalized && isMissing(preference.phone)) {
    updates.phone = options.phone;
    updates.phone_normalized = phoneNormalized;
  }

  if (Object.keys(updates).length === 0) {
    return preference;
  }

  const { data, error } = await supabaseAdmin
    .from("client_communication_preferences")
    .update(updates)
    .eq("id", preference.id)
    .select("*")
    .maybeSingle();

  handleSupabaseError(error, "Unable to update communication preference");
  return (data as Row | null) ?? preference;
};

const getEmailAllowed = (preference: Row, messageType: MessageType): CanSendCommunicationResult => {
  const critical = ["appointment_confirmation", "appointment_cancelled", "appointment_rescheduled"].includes(messageType);
  const optedOutAll = isTruthy(preference.opted_out_all_email);

  if (optedOutAll && !critical) {
    return { canSend: false, reason: "opted_out", preference };
  }

  if (critical || messageType === "waitlist_update") {
    return isTruthy(preference.email_transactional_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "disabled", preference };
  }

  if (messageType === "appointment_reminder") {
    return isTruthy(preference.email_reminders_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "opted_out", preference };
  }

  if (messageType === "rebooking_prompt") {
    return isTruthy(preference.email_rebooking_enabled) && isTruthy(preference.email_marketing_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "opted_out", preference };
  }

  return isTruthy(preference.email_marketing_enabled)
    ? { canSend: true, preference }
    : { canSend: false, reason: "opted_out", preference };
};

const getSmsAllowed = (preference: Row, messageType: MessageType): CanSendCommunicationResult => {
  if (!preference.sms_opted_in_at) {
    return { canSend: false, reason: "missing_sms_consent", preference };
  }

  if (isTruthy(preference.opted_out_all_sms)) {
    return { canSend: false, reason: "opted_out", preference };
  }

  if (["appointment_confirmation", "appointment_cancelled", "appointment_rescheduled", "waitlist_update"].includes(messageType)) {
    return isTruthy(preference.sms_transactional_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "disabled", preference };
  }

  if (messageType === "appointment_reminder") {
    return isTruthy(preference.sms_reminders_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "disabled", preference };
  }

  if (messageType === "rebooking_prompt") {
    return isTruthy(preference.sms_rebooking_enabled) && isTruthy(preference.sms_marketing_enabled)
      ? { canSend: true, preference }
      : { canSend: false, reason: "disabled", preference };
  }

  return isTruthy(preference.sms_marketing_enabled)
    ? { canSend: true, preference }
    : { canSend: false, reason: "disabled", preference };
};

export const communicationPreferencesService = {
  async getOrCreateCommunicationPreference(options: PreferenceContactOptions): Promise<Row> {
    const emailNormalized = normalizeEmail(options.email);
    const phoneNormalized = normalizePhone(options.phone);

    if (!emailNormalized && !phoneNormalized) {
      throw new ApiError(400, "Communication preference requires email or phone");
    }

    const existing = await findPreferenceByContact(options.userId, emailNormalized, phoneNormalized);
    if (existing) {
      return updateMissingPreferenceFields(existing, options, emailNormalized, phoneNormalized);
    }

    const { data, error } = await supabaseAdmin
      .from("client_communication_preferences")
      .insert({
        user_id: options.userId,
        client_id: options.clientId ?? null,
        stylist_id: options.stylistId ?? null,
        email: options.email ?? null,
        email_normalized: emailNormalized,
        phone: options.phone ?? null,
        phone_normalized: phoneNormalized
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create communication preference");
    return data as Row;
  },

  async canSendCommunication(options: CanSendCommunicationOptions): Promise<CanSendCommunicationResult> {
    const normalized = normalizeContact(options.channel, options.to);
    if (!normalized) {
      return { canSend: false, reason: "missing_contact" };
    }

    const preference = await findPreferenceByContact(
      options.userId,
      options.channel === "email" ? normalized : null,
      options.channel === "sms" ? normalized : null
    );

    if (!preference) {
      if (options.channel === "sms") {
        return { canSend: false, reason: "missing_sms_consent", toNormalized: normalized };
      }

      const createdPreference = await this.getOrCreateCommunicationPreference({
        userId: options.userId,
        clientId: options.clientId,
        stylistId: options.stylistId,
        email: options.to ?? null
      });
      return { canSend: true, preference: createdPreference, toNormalized: normalized };
    }

    const result = options.channel === "email"
      ? getEmailAllowed(preference, options.messageType)
      : getSmsAllowed(preference, options.messageType);

    return { ...result, toNormalized: normalized };
  },

  async optInSms(options: OptInSmsOptions): Promise<Row> {
    if (!options.consentText.trim()) {
      throw new ApiError(400, "SMS opt-in requires consent text");
    }

    const phoneNormalized = normalizePhone(options.phone);
    if (!phoneNormalized) {
      throw new ApiError(400, "SMS opt-in requires a valid phone number");
    }

    const preference = await this.getOrCreateCommunicationPreference({
      userId: options.userId,
      clientId: options.clientId,
      stylistId: options.stylistId,
      phone: options.phone
    });

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("client_communication_preferences")
      .update({
        sms_transactional_enabled: options.enableTransactional ?? true,
        sms_reminders_enabled: options.enableReminders ?? true,
        sms_marketing_enabled: options.enableMarketing ?? false,
        sms_rebooking_enabled: options.enableRebooking ?? false,
        opted_out_all_sms: false,
        sms_opted_in_at: now,
        sms_opt_in_source: options.source,
        sms_opt_in_text: options.consentText,
        sms_opted_out_at: null,
        sms_opt_out_source: null
      })
      .eq("id", preference.id)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to opt in SMS preference");

    await communicationEventsService.logConsentEvent({
      userId: options.userId,
      clientId: options.clientId,
      stylistId: options.stylistId,
      channel: "sms",
      contactValue: options.phone,
      contactNormalized: phoneNormalized,
      eventType: "opted_in",
      source: options.source,
      consentText: options.consentText
    });

    return data as Row;
  }
};
