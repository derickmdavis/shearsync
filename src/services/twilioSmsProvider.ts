import Twilio from "twilio";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import type { SmsMessage, SmsProvider, SmsProviderResult } from "./smsDeliveryService";

interface TwilioMessageClient {
  messages: {
    create(input: { to: string; body: string; messagingServiceSid: string }): Promise<{ sid: string }>;
  };
}

export interface TwilioSmsProviderConfig {
  accountSid?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  messagingServiceSid?: string;
}

export class SmsProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SmsProviderError";
  }
}

const requiredValues = (config: TwilioSmsProviderConfig) => {
  const accountSid = config.accountSid?.trim();
  const apiKeySid = config.apiKeySid?.trim();
  const apiKeySecret = config.apiKeySecret?.trim();
  const messagingServiceSid = config.messagingServiceSid?.trim();
  if (!accountSid || !apiKeySid || !apiKeySecret || !messagingServiceSid) {
    throw new ApiError(503, "Twilio SMS provider is not fully configured");
  }
  return { accountSid, apiKeySid, apiKeySecret, messagingServiceSid };
};

const configuredValues = (): TwilioSmsProviderConfig => ({
  accountSid: env.TWILIO_ACCOUNT_SID,
  apiKeySid: env.TWILIO_API_KEY_SID,
  apiKeySecret: env.TWILIO_API_KEY_SECRET,
  messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID
});

/** Validates outbound Twilio configuration before a worker claims an outbox record. */
export const assertTwilioSmsProviderConfigured = (): void => {
  requiredValues(configuredValues());
};

const providerErrorCode = (error: unknown): string =>
  error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
    ? `twilio_${(error as { code: number }).code}`
    : "twilio_request_failed";

/** Uses Twilio API-key auth and a Messaging Service; it never chooses a From number directly. */
export const createTwilioSmsProvider = (
  config: TwilioSmsProviderConfig = configuredValues(),
  injectedClient?: TwilioMessageClient
): SmsProvider => {
  const values = requiredValues(config);
  const client = injectedClient ?? Twilio(values.apiKeySid, values.apiKeySecret, { accountSid: values.accountSid });
  return {
    async send(message: SmsMessage): Promise<SmsProviderResult> {
      try {
        const result = await client.messages.create({
          to: message.to,
          body: message.body,
          messagingServiceSid: values.messagingServiceSid
        });
        return { status: "sent", provider: "twilio", providerMessageId: result.sid };
      } catch (error) {
        // Provider payloads can contain recipient data; never surface or log them.
        throw new SmsProviderError(providerErrorCode(error), "Twilio rejected the SMS request.");
      }
    }
  };
};
