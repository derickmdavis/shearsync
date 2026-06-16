import { supabaseAdmin } from "../lib/supabase";
import type {
  CommunicationChannel,
  CommunicationEventStatus,
  ConsentEventType,
  ConsentSource,
  MessageType
} from "../lib/communications";
import type { Row } from "./db";

interface LogCommunicationEventOptions {
  userId: string;
  clientId?: string | null;
  channel: CommunicationChannel;
  messageType?: MessageType | null;
  toAddress?: string | null;
  toNormalized?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  status: CommunicationEventStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Row | null;
}

interface LogConsentEventOptions {
  userId: string;
  clientId?: string | null;
  channel: CommunicationChannel;
  contactValue?: string | null;
  contactNormalized?: string | null;
  eventType: ConsentEventType;
  source: ConsentSource;
  messageType?: MessageType | null;
  consentText?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Row | null;
}

const logFailure = (label: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${label}: ${message}`);
};

export const communicationEventsService = {
  async logCommunicationEvent(options: LogCommunicationEventOptions): Promise<void> {
    try {
      const { error } = await supabaseAdmin.from("communication_events").insert({
        user_id: options.userId,
        client_id: options.clientId ?? null,
        channel: options.channel,
        message_type: options.messageType ?? null,
        to_address: options.toAddress ?? null,
        to_normalized: options.toNormalized ?? null,
        provider: options.provider ?? null,
        provider_message_id: options.providerMessageId ?? null,
        status: options.status,
        error_code: options.errorCode ?? null,
        error_message: options.errorMessage ?? null,
        metadata: options.metadata ?? {}
      });

      if (error) {
        logFailure("Unable to log communication event", error);
      }
    } catch (error) {
      logFailure("Unable to log communication event", error);
    }
  },

  async logConsentEvent(options: LogConsentEventOptions): Promise<void> {
    try {
      const { error } = await supabaseAdmin.from("communication_consent_events").insert({
        user_id: options.userId,
        client_id: options.clientId ?? null,
        channel: options.channel,
        contact_value: options.contactValue ?? null,
        contact_normalized: options.contactNormalized ?? null,
        event_type: options.eventType,
        source: options.source,
        message_type: options.messageType ?? null,
        consent_text: options.consentText ?? null,
        ip_address: options.ipAddress ?? null,
        user_agent: options.userAgent ?? null,
        metadata: options.metadata ?? {}
      });

      if (error) {
        logFailure("Unable to log communication consent event", error);
      }
    } catch (error) {
      logFailure("Unable to log communication consent event", error);
    }
  }
};
