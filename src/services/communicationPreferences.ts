import { ApiError } from "../lib/errors";
import {
  type CommunicationChannel,
  type ConsentSource,
  type MessageType,
  isAppointmentUpdateMessage,
  normalizeContact,
  normalizeEmail,
  normalizePhone
} from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { communicationEventsService } from "./communicationEvents";
import { globalEmailUnsubscribesService, isGlobalEmailUnsubscribeExempt } from "./globalEmailUnsubscribesService";

interface PreferenceContactOptions {
  userId: string;
  clientId?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface CanSendCommunicationOptions {
  userId: string;
  clientId?: string | null;
  channel: CommunicationChannel;
  to?: string | null;
  messageType: MessageType;
  globalEmailUnsubscribeCache?: Map<string, boolean>;
}

export interface CanSendCommunicationResult {
  canSend: boolean;
  reason?: "missing_contact" | "missing_sms_consent" | "opted_out" | "disabled" | "global_unsubscribe";
  preference?: Row;
  toNormalized?: string;
}

interface CommunicationEligibilityCandidate {
  id: string;
  clientId?: string | null;
  channel: CommunicationChannel;
  to?: string | null;
  messageType: MessageType;
}

interface OptInSmsOptions {
  userId: string;
  clientId?: string | null;
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
  const appointmentUpdate = isAppointmentUpdateMessage(messageType);
  const optedOutAll = isTruthy(preference.opted_out_all_email);

  if (optedOutAll && !appointmentUpdate) {
    return { canSend: false, reason: "opted_out", preference };
  }

  if (appointmentUpdate || messageType === "waitlist_update") {
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

const loadPreferencesByNormalizedContact = async (
  userId: string,
  emailNormalizedValues: string[],
  phoneNormalizedValues: string[]
): Promise<{
  byEmail: Map<string, Row>;
  byPhone: Map<string, Row>;
}> => {
  const [emailResult, phoneResult] = await Promise.all([
    emailNormalizedValues.length > 0
      ? supabaseAdmin
        .from("client_communication_preferences")
        .select("*")
        .eq("user_id", userId)
        .in("email_normalized", emailNormalizedValues)
      : Promise.resolve({ data: [], error: null }),
    phoneNormalizedValues.length > 0
      ? supabaseAdmin
        .from("client_communication_preferences")
        .select("*")
        .eq("user_id", userId)
        .in("phone_normalized", phoneNormalizedValues)
      : Promise.resolve({ data: [], error: null })
  ]);

  handleSupabaseError(emailResult.error, "Unable to load communication preferences");
  handleSupabaseError(phoneResult.error, "Unable to load communication preferences");

  const byEmail = new Map<string, Row>();
  const byPhone = new Map<string, Row>();

  for (const preference of (emailResult.data ?? []) as Row[]) {
    if (typeof preference.email_normalized === "string") {
      byEmail.set(preference.email_normalized, preference);
    }
  }

  for (const preference of (phoneResult.data ?? []) as Row[]) {
    if (typeof preference.phone_normalized === "string") {
      byPhone.set(preference.phone_normalized, preference);
    }
  }

  return { byEmail, byPhone };
};

const loadGlobalUnsubscribedEmails = async (emailNormalizedValues: string[]): Promise<Set<string>> => {
  if (emailNormalizedValues.length === 0) {
    return new Set();
  }

  const { data, error } = await supabaseAdmin
    .from("global_email_unsubscribes")
    .select("email_normalized")
    .in("email_normalized", emailNormalizedValues);

  handleSupabaseError(error, "Unable to load global email unsubscribes");
  return new Set(
    ((data ?? []) as Row[])
      .map((row) => (typeof row.email_normalized === "string" ? row.email_normalized : null))
      .filter((value): value is string => value !== null)
  );
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

    if (options.channel === "email" && !isGlobalEmailUnsubscribeExempt(options.messageType)) {
      let isGloballyUnsubscribed = options.globalEmailUnsubscribeCache?.get(normalized);
      if (isGloballyUnsubscribed === undefined) {
        isGloballyUnsubscribed = await globalEmailUnsubscribesService.isGloballyUnsubscribed(normalized);
        options.globalEmailUnsubscribeCache?.set(normalized, isGloballyUnsubscribed);
      }

      if (isGloballyUnsubscribed) {
        return { canSend: false, reason: "global_unsubscribe", toNormalized: normalized };
      }
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
        email: options.to ?? null
      });
      return { canSend: true, preference: createdPreference, toNormalized: normalized };
    }

    const result = options.channel === "email"
      ? getEmailAllowed(preference, options.messageType)
      : getSmsAllowed(preference, options.messageType);

    return { ...result, toNormalized: normalized };
  },

  async canSendCommunicationsReadOnly(
    userId: string,
    candidates: CommunicationEligibilityCandidate[]
  ): Promise<Map<string, CanSendCommunicationResult>> {
    const normalizedCandidates = candidates.map((candidate) => ({
      ...candidate,
      toNormalized: normalizeContact(candidate.channel, candidate.to)
    }));
    const emailNormalizedValues = [
      ...new Set(
        normalizedCandidates
          .filter((candidate) => candidate.channel === "email" && candidate.toNormalized)
          .map((candidate) => candidate.toNormalized as string)
      )
    ];
    const phoneNormalizedValues = [
      ...new Set(
        normalizedCandidates
          .filter((candidate) => candidate.channel === "sms" && candidate.toNormalized)
          .map((candidate) => candidate.toNormalized as string)
      )
    ];
    const globalEmailValues = [
      ...new Set(
        normalizedCandidates
          .filter((candidate) =>
            candidate.channel === "email"
            && candidate.toNormalized
            && !isGlobalEmailUnsubscribeExempt(candidate.messageType)
          )
          .map((candidate) => candidate.toNormalized as string)
      )
    ];

    const [preferences, globalUnsubscribedEmails] = await Promise.all([
      loadPreferencesByNormalizedContact(userId, emailNormalizedValues, phoneNormalizedValues),
      loadGlobalUnsubscribedEmails(globalEmailValues)
    ]);

    return new Map(
      normalizedCandidates.map((candidate): [string, CanSendCommunicationResult] => {
        if (!candidate.toNormalized) {
          return [candidate.id, { canSend: false, reason: "missing_contact" }];
        }

        if (
          candidate.channel === "email"
          && !isGlobalEmailUnsubscribeExempt(candidate.messageType)
          && globalUnsubscribedEmails.has(candidate.toNormalized)
        ) {
          return [
            candidate.id,
            { canSend: false, reason: "global_unsubscribe", toNormalized: candidate.toNormalized }
          ];
        }

        const preference = candidate.channel === "email"
          ? preferences.byEmail.get(candidate.toNormalized)
          : preferences.byPhone.get(candidate.toNormalized);

        if (!preference) {
          return candidate.channel === "sms"
            ? [
              candidate.id,
              { canSend: false, reason: "missing_sms_consent", toNormalized: candidate.toNormalized }
            ]
            : [
              candidate.id,
              { canSend: true, toNormalized: candidate.toNormalized }
            ];
        }

        const result = candidate.channel === "email"
          ? getEmailAllowed(preference, candidate.messageType)
          : getSmsAllowed(preference, candidate.messageType);

        return [candidate.id, { ...result, toNormalized: candidate.toNormalized }];
      })
    );
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
