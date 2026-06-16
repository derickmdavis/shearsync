import { ApiError } from "../lib/errors";
import { normalizeContact, normalizePhone, type CommunicationChannel, type MessageType } from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { communicationEventsService } from "./communicationEvents";
import { communicationPreferenceTokensService } from "./communicationPreferenceTokens";
import { communicationPreferencesService } from "./communicationPreferences";
import { globalEmailUnsubscribesService } from "./globalEmailUnsubscribesService";

interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface InboundSmsOptions extends RequestContext {
  from?: string | null;
  to?: string | null;
  body?: string | null;
  messageSid?: string | null;
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

const html = (message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Communication preferences</title></head><body><p>${message}</p></body></html>`;

const safeTokenError = (): ApiError => new ApiError(404, "This unsubscribe link is invalid or expired.");

const unsubscribeUpdates = (channel: CommunicationChannel): Row => {
  const now = new Date().toISOString();

  if (channel === "sms") {
    return {
      opted_out_all_sms: true,
      sms_transactional_enabled: false,
      sms_reminders_enabled: false,
      sms_marketing_enabled: false,
      sms_rebooking_enabled: false,
      sms_opted_out_at: now,
      sms_opt_out_source: "unsubscribe_link"
    };
  }

  const updates: Row = {
    email_reminders_enabled: false,
    email_marketing_enabled: false,
    email_rebooking_enabled: false,
    email_opted_out_at: now,
    email_opt_out_source: "unsubscribe_link",
    opted_out_all_email: false
  };

  return updates;
};

const getInboundRows = async (phoneNormalized: string): Promise<RowList> => {
  const { data, error } = await supabaseAdmin
    .from("client_communication_preferences")
    .select("*")
    .eq("phone_normalized", phoneNormalized);

  handleSupabaseError(error, "Unable to load SMS communication preferences");
  return (data ?? []) as RowList;
};

const updateSmsPreferences = async (preferenceIds: string[], updates: Row): Promise<void> => {
  if (preferenceIds.length === 0) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("client_communication_preferences")
    .update(updates)
    .in("id", preferenceIds);

  handleSupabaseError(error, "Unable to update SMS communication preferences");
};

export const communicationsService = {
  async unsubscribe(rawToken: string, context: RequestContext = {}): Promise<string> {
    let token: Row;

    try {
      token = await communicationPreferenceTokensService.consumeCommunicationPreferenceToken(rawToken);
    } catch {
      throw safeTokenError();
    }

    const userId = String(token.user_id ?? "");
    const channel = token.channel as CommunicationChannel;
    const contactValue = String(token.contact_value ?? "");
    const messageType = typeof token.message_type === "string" ? token.message_type as MessageType : null;
    const contactNormalized = normalizeContact(channel, contactValue);

    if (!userId || !["email", "sms"].includes(channel) || !contactNormalized) {
      throw safeTokenError();
    }

    const preference = await communicationPreferencesService.getOrCreateCommunicationPreference({
      userId,
      clientId: typeof token.client_id === "string" ? token.client_id : null,
      email: channel === "email" ? contactValue : null,
      phone: channel === "sms" ? contactValue : null
    });

    const { error } = await supabaseAdmin
      .from("client_communication_preferences")
      .update(unsubscribeUpdates(channel))
      .eq("id", preference.id);

    handleSupabaseError(error, "Unable to update communication preferences");

    if (channel === "email") {
      await globalEmailUnsubscribesService.upsertGlobalEmailUnsubscribe({
        email: contactValue,
        source: "unsubscribe_link",
        userId,
        clientId: typeof token.client_id === "string" ? token.client_id : null,
        stylistId: userId,
        messageType,
        preferenceTokenId: typeof token.id === "string" ? token.id : null,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      });
    }

    await communicationEventsService.logConsentEvent({
      userId,
      clientId: typeof token.client_id === "string" ? token.client_id : null,
      channel,
      contactValue,
      contactNormalized,
      eventType: "unsubscribe_link_clicked",
      source: "unsubscribe_link",
      messageType,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });

    await communicationEventsService.logCommunicationEvent({
      userId,
      clientId: typeof token.client_id === "string" ? token.client_id : null,
      channel,
      messageType,
      toAddress: contactValue,
      toNormalized: contactNormalized,
      status: "unsubscribed"
    });

    if (channel === "sms") {
      return html("You have been unsubscribed from non-essential text messages.");
    }

    return html("You have been unsubscribed from non-essential emails. You may still receive appointment confirmations, cancellations, and reschedule updates.");
  },

  async handleInboundSms(options: InboundSmsOptions): Promise<string> {
    // TODO: Validate provider signatures when a concrete SMS provider is configured.
    const fromNormalized = normalizePhone(options.from);
    const keyword = typeof options.body === "string" ? options.body.trim().toUpperCase() : "";

    if (!fromNormalized) {
      throw new ApiError(400, "Inbound SMS requires a valid From number");
    }

    const preferences = await getInboundRows(fromNormalized);
    const preferenceIds = preferences
      .map((preference) => preference.id)
      .filter((id): id is string => typeof id === "string");

    if (STOP_KEYWORDS.has(keyword)) {
      await updateSmsPreferences(preferenceIds, {
        opted_out_all_sms: true,
        sms_transactional_enabled: false,
        sms_reminders_enabled: false,
        sms_marketing_enabled: false,
        sms_rebooking_enabled: false,
        sms_opted_out_at: new Date().toISOString(),
        sms_opt_out_source: "inbound_sms"
      });

      await Promise.all(preferences.map((preference) => communicationEventsService.logConsentEvent({
        userId: String(preference.user_id ?? ""),
        clientId: typeof preference.client_id === "string" ? preference.client_id : null,
        channel: "sms",
        contactValue: options.from ?? null,
        contactNormalized: fromNormalized,
        eventType: "inbound_stop",
        source: "inbound_sms",
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        metadata: { provider_message_id: options.messageSid ?? null, provider_to: options.to ?? null }
      })));

      await Promise.all(preferences.map((preference) => communicationEventsService.logCommunicationEvent({
        userId: String(preference.user_id ?? ""),
        clientId: typeof preference.client_id === "string" ? preference.client_id : null,
        channel: "sms",
        toAddress: options.from ?? null,
        toNormalized: fromNormalized,
        providerMessageId: options.messageSid ?? null,
        status: "inbound_stop"
      })));

      return "You are unsubscribed from DripDesk text messages. Reply START to opt back in.";
    }

    if (START_KEYWORDS.has(keyword)) {
      await updateSmsPreferences(preferenceIds, {
        opted_out_all_sms: false,
        sms_transactional_enabled: true,
        sms_reminders_enabled: true,
        sms_marketing_enabled: false,
        sms_rebooking_enabled: false,
        sms_opted_in_at: new Date().toISOString(),
        sms_opt_in_source: "inbound_sms",
        sms_opted_out_at: null,
        sms_opt_out_source: null
      });

      await Promise.all(preferences.map((preference) => communicationEventsService.logConsentEvent({
        userId: String(preference.user_id ?? ""),
        clientId: typeof preference.client_id === "string" ? preference.client_id : null,
        channel: "sms",
        contactValue: options.from ?? null,
        contactNormalized: fromNormalized,
        eventType: "inbound_start",
        source: "inbound_sms",
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        metadata: { provider_message_id: options.messageSid ?? null, provider_to: options.to ?? null }
      })));

      return "You are opted back in to appointment text updates from DripDesk. Reply STOP to opt out.";
    }

    if (HELP_KEYWORDS.has(keyword)) {
      await Promise.all(preferences.map((preference) => communicationEventsService.logCommunicationEvent({
        userId: String(preference.user_id ?? ""),
        clientId: typeof preference.client_id === "string" ? preference.client_id : null,
        channel: "sms",
        toAddress: options.from ?? null,
        toNormalized: fromNormalized,
        providerMessageId: options.messageSid ?? null,
        status: "inbound_help"
      })));

      return "DripDesk sends appointment messages for your stylist or barber. Reply STOP to opt out.";
    }

    return "DripDesk received your message. Reply HELP for help or STOP to opt out.";
  }
};
