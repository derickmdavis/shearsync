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
  requireExplicitMarketingConsent?: boolean;
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
  requireExplicitMarketingConsent?: boolean;
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

export interface SmsConsentPreference {
  clientId: string;
  phone: string;
  phoneNormalized: string;
  optedIn: boolean;
  optedOut: boolean;
  categories: {
    transactional: boolean;
    reminders: boolean;
    marketing: boolean;
    rebooking: boolean;
  };
  consent: {
    optedInAt: string | null;
    optedInSource: string | null;
    optedInText: string | null;
    optedOutAt: string | null;
    optedOutSource: string | null;
    lastAuditEventId: string | null;
  };
  consentScope: "account";
}

interface ManualSmsPreferenceUpdateOptions {
  action: "preferences" | "opt_in" | "opt_out";
  source: ConsentSource;
  consentText?: string;
  transactionalEnabled?: boolean;
  remindersEnabled?: boolean;
  marketingEnabled?: boolean;
  rebookingEnabled?: boolean;
}

interface PublicBookingSmsOptInOptions {
  userId: string;
  clientId: string;
  phone: string;
  consentText: string;
  appointmentId: string;
  disclosureVersion: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface InboundSmsConsentOptions {
  from: string;
  fromNormalized: string;
  messageSid?: string | null;
  classification: "stop" | "start" | "help" | "other";
  inboundEventId: string;
  metadata: Row;
}

const isTruthy = (value: unknown): boolean => value === true;
const isMissing = (value: unknown): boolean => value === null || value === undefined || value === "";
const CONTACT_LOOKUP_BATCH_SIZE = 200;

const chunkValues = (values: string[]): string[][] => {
  const uniqueValues = [...new Set(values)];
  const chunks: string[][] = [];

  for (let index = 0; index < uniqueValues.length; index += CONTACT_LOOKUP_BATCH_SIZE) {
    chunks.push(uniqueValues.slice(index, index + CONTACT_LOOKUP_BATCH_SIZE));
  }

  return chunks;
};

const loadPreferenceRowsByContact = async (
  userId: string,
  column: "email_normalized" | "phone_normalized",
  values: string[]
): Promise<Row[]> => {
  const results = await Promise.all(
    chunkValues(values).map((batch) =>
      supabaseAdmin
        .from("client_communication_preferences")
        .select("*")
        .eq("user_id", userId)
        .in(column, batch)
    )
  );

  return results.flatMap((result) => {
    handleSupabaseError(result.error, "Unable to load communication preferences");
    return (result.data ?? []) as Row[];
  });
};

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

const getClientSmsContact = async (userId: string, clientId: string): Promise<{ phone: string; phoneNormalized: string }> => {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, phone")
    .eq("id", clientId)
    .eq("user_id", userId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load client");
  if (!data) throw new ApiError(404, "Client not found");
  const phone = typeof data.phone === "string" ? data.phone : null;
  const phoneNormalized = normalizePhone(phone);
  if (!phone || !phoneNormalized) throw new ApiError(400, "Client requires a valid phone number for SMS preferences");
  return { phone, phoneNormalized };
};

const toSmsConsentPreference = (clientId: string, preference: Row): SmsConsentPreference => ({
  clientId,
  phone: String(preference.phone ?? ""),
  phoneNormalized: String(preference.phone_normalized ?? ""),
  optedIn: Boolean(preference.sms_opted_in_at) && !isTruthy(preference.opted_out_all_sms),
  optedOut: isTruthy(preference.opted_out_all_sms),
  categories: {
    transactional: isTruthy(preference.sms_transactional_enabled),
    reminders: isTruthy(preference.sms_reminders_enabled),
    marketing: isTruthy(preference.sms_marketing_enabled),
    rebooking: isTruthy(preference.sms_rebooking_enabled)
  },
  consent: {
    optedInAt: typeof preference.sms_opted_in_at === "string" ? preference.sms_opted_in_at : null,
    optedInSource: typeof preference.sms_opt_in_source === "string" ? preference.sms_opt_in_source : null,
    optedInText: typeof preference.sms_opt_in_text === "string" ? preference.sms_opt_in_text : null,
    optedOutAt: typeof preference.sms_opted_out_at === "string" ? preference.sms_opted_out_at : null,
    optedOutSource: typeof preference.sms_opt_out_source === "string" ? preference.sms_opt_out_source : null,
    lastAuditEventId: typeof preference.sms_last_consent_event_id === "string" ? preference.sms_last_consent_event_id : null
  },
  consentScope: "account"
});

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
  const [emailPreferences, phonePreferences] = await Promise.all([
    loadPreferenceRowsByContact(userId, "email_normalized", emailNormalizedValues),
    loadPreferenceRowsByContact(userId, "phone_normalized", phoneNormalizedValues)
  ]);

  const byEmail = new Map<string, Row>();
  const byPhone = new Map<string, Row>();

  for (const preference of emailPreferences) {
    if (typeof preference.email_normalized === "string") {
      byEmail.set(preference.email_normalized, preference);
    }
  }

  for (const preference of phonePreferences) {
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

  const results = await Promise.all(
    chunkValues(emailNormalizedValues).map((batch) =>
      supabaseAdmin
        .from("global_email_unsubscribes")
        .select("email_normalized")
        .in("email_normalized", batch)
    )
  );

  const rows = results.flatMap((result) => {
    handleSupabaseError(result.error, "Unable to load global email unsubscribes");
    return (result.data ?? []) as Row[];
  });

  return new Set(
    rows
      .map((row) => (typeof row.email_normalized === "string" ? row.email_normalized : null))
      .filter((value): value is string => value !== null)
  );
};

export const communicationPreferencesService = {
  async getSmsPreferenceForClient(userId: string, clientId: string): Promise<SmsConsentPreference> {
    const { phone } = await getClientSmsContact(userId, clientId);
    const preference = await this.getOrCreateCommunicationPreference({ userId, clientId, phone });
    return toSmsConsentPreference(clientId, preference);
  },

  async updateSmsPreferenceForClient(
    userId: string,
    clientId: string,
    options: ManualSmsPreferenceUpdateOptions
  ): Promise<SmsConsentPreference> {
    const { phone, phoneNormalized } = await getClientSmsContact(userId, clientId);
    if (options.action === "opt_in" && !options.consentText?.trim()) {
      throw new ApiError(400, "SMS opt-in requires consent text");
    }
    if (
      options.action === "preferences"
      && [options.transactionalEnabled, options.remindersEnabled, options.marketingEnabled, options.rebookingEnabled]
        .every((value) => value === undefined)
    ) {
      throw new ApiError(400, "Provide at least one SMS preference category");
    }
    if (options.action === "preferences") {
      const current = await this.getSmsPreferenceForClient(userId, clientId);
      if (!current.optedIn) throw new ApiError(400, "SMS preferences require an explicit opt-in");
      const unchanged = (
        (options.transactionalEnabled === undefined || options.transactionalEnabled === current.categories.transactional)
        && (options.remindersEnabled === undefined || options.remindersEnabled === current.categories.reminders)
        && (options.marketingEnabled === undefined || options.marketingEnabled === current.categories.marketing)
        && (options.rebookingEnabled === undefined || options.rebookingEnabled === current.categories.rebooking)
      );
      if (unchanged) return current;
    }

    const { data, error } = await supabaseAdmin.rpc("apply_manual_sms_preference", {
      p_user_id: userId,
      p_client_id: clientId,
      p_phone: phone,
      p_phone_normalized: phoneNormalized,
      p_action: options.action,
      p_source: options.source,
      p_consent_text: options.consentText?.trim() ?? null,
      p_has_transactional: options.transactionalEnabled !== undefined,
      p_transactional_enabled: options.transactionalEnabled ?? null,
      p_has_reminders: options.remindersEnabled !== undefined,
      p_reminders_enabled: options.remindersEnabled ?? null,
      p_has_marketing: options.marketingEnabled !== undefined,
      p_marketing_enabled: options.marketingEnabled ?? null,
      p_has_rebooking: options.rebookingEnabled !== undefined,
      p_rebooking_enabled: options.rebookingEnabled ?? null
    });
    handleSupabaseError(error, "Unable to update SMS communication preferences");
    return toSmsConsentPreference(clientId, data as Row);
  },

  async optInSmsForPublicBooking(options: PublicBookingSmsOptInOptions): Promise<SmsConsentPreference> {
    const consentText = options.consentText.trim();
    if (!consentText) {
      throw new ApiError(400, "SMS opt-in requires consent text");
    }

    const phoneNormalized = normalizePhone(options.phone);
    if (!phoneNormalized) {
      throw new ApiError(400, "SMS opt-in requires a valid phone number");
    }

    const { data, error } = await supabaseAdmin.rpc("apply_manual_sms_preference", {
      p_user_id: options.userId,
      p_client_id: options.clientId,
      p_phone: options.phone,
      p_phone_normalized: phoneNormalized,
      p_action: "opt_in",
      p_source: "booking_page",
      p_consent_text: consentText,
      p_has_transactional: true,
      p_transactional_enabled: true,
      p_has_reminders: true,
      p_reminders_enabled: true,
      p_has_marketing: false,
      p_marketing_enabled: false,
      p_has_rebooking: false,
      p_rebooking_enabled: false,
      p_ip_address: options.ipAddress ?? null,
      p_user_agent: options.userAgent ?? null,
      p_metadata: {
        booking_source: "public",
        appointment_id: options.appointmentId,
        disclosure_version: options.disclosureVersion
      }
    });
    handleSupabaseError(error, "Unable to record public-booking SMS consent");
    return toSmsConsentPreference(options.clientId, data as Row);
  },

  async applyInboundSmsConsent(options: InboundSmsConsentOptions): Promise<void> {
    if (!["stop", "start", "help"].includes(options.classification)) return;
    const { error } = await supabaseAdmin.rpc("apply_inbound_sms_consent", {
      p_from: options.from,
      p_from_normalized: options.fromNormalized,
      p_provider_message_id: options.messageSid ?? null,
      p_classification: options.classification,
      p_inbound_event_id: options.inboundEventId,
      p_metadata: options.metadata
    });
    handleSupabaseError(error, "Unable to apply inbound SMS consent");
  },

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

      if (options.messageType === "marketing" && options.requireExplicitMarketingConsent) {
        return { canSend: false, reason: "disabled", toNormalized: normalized };
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
            : candidate.messageType === "marketing" && candidate.requireExplicitMarketingConsent
              ? [
                candidate.id,
                { canSend: false, reason: "disabled", toNormalized: candidate.toNormalized }
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
