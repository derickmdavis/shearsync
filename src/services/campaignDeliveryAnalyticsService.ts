import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { ApiError } from "../lib/errors";
import { hashToken } from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row } from "./db";

type AnalyticsEventType = "delivered" | "opened" | "clicked" | "bounced" | "complained";

const providerTypes: Record<string, AnalyticsEventType | undefined> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained"
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const isAutomatedUserAgent = (userAgent: string | null): boolean =>
  Boolean(userAgent && /bot|crawler|spider|preview|scanner|slurp|facebookexternalhit|linkedinbot/i.test(userAgent));

const isDuplicateError = (error: { code?: string | null } | null): boolean => error?.code === "23505";

const insertEvent = async (event: Row): Promise<{ inserted: boolean; recipient: Row | null }> => {
  const { data: existing, error: existingError } = await supabaseAdmin.from("campaign_delivery_events")
    .select("id, campaign_recipient_id").eq("provider", event.provider).eq("provider_event_id", event.provider_event_id).maybeSingle();
  handleSupabaseError(existingError, "Unable to inspect campaign delivery event");
  if (existing) return { inserted: false, recipient: null };

  const { error } = await supabaseAdmin.from("campaign_delivery_events").insert(event);
  if (isDuplicateError(error)) return { inserted: false, recipient: null };
  handleSupabaseError(error, "Unable to record campaign delivery event");
  return { inserted: true, recipient: null };
};

const markDelivered = async (recipientId: string, occurredAt: string): Promise<void> => {
  const { error } = await supabaseAdmin.from("campaign_recipients")
    .update({ status: "delivered", delivered_at: occurredAt })
    .eq("id", recipientId).eq("status", "sent");
  handleSupabaseError(error, "Unable to mark campaign recipient delivered");
};

export const verifyResendWebhookSignature = (
  rawBody: Buffer,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string
): boolean => {
  const id = headers.id;
  const timestamp = headers.timestamp;
  const signature = headers.signature;
  if (!id || !timestamp || !signature) return false;
  const secretValue = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBuffer = Buffer.from(secretValue, "base64");
  if (secretBuffer.length === 0) return false;
  const expected = createHmac("sha256", secretBuffer).update(`${id}.${timestamp}.${rawBody.toString("utf8")}`).digest("base64");
  return signature.split(" ").some((part) => {
    const supplied = part.startsWith("v1,") ? part.slice(3) : part;
    const suppliedBuffer = Buffer.from(supplied, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  });
};

export const campaignDeliveryAnalyticsService = {
  async recordResendWebhook(payload: unknown, providerEventId: string): Promise<{ accepted: boolean; duplicate: boolean }> {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
    const eventType = providerTypes[stringValue(body.type) ?? ""];
    const messageId = stringValue(data.email_id) ?? stringValue(data.message_id);
    if (!eventType || !messageId || !providerEventId) return { accepted: false, duplicate: false };

    const { data: recipient, error } = await supabaseAdmin.from("campaign_recipients").select("*")
      .eq("provider", "resend").eq("provider_message_id", messageId).maybeSingle();
    handleSupabaseError(error, "Unable to find campaign recipient for provider event");
    if (!recipient) return { accepted: false, duplicate: false };

    const occurredAt = stringValue(data.created_at) ?? new Date().toISOString();
    const inserted = await insertEvent({
      campaign_id: recipient.campaign_id,
      campaign_recipient_id: recipient.id,
      user_id: recipient.user_id,
      provider: "resend",
      provider_event_id: providerEventId,
      provider_message_id: messageId,
      event_type: eventType,
      occurred_at: occurredAt,
      url: stringValue((data.click as Record<string, unknown> | undefined)?.url),
      is_automated: data.is_automated === true,
      privacy_limited: data.privacy_limited === true || data.user_agent === "AppleMail",
      provider_payload: body
    });
    if (inserted.inserted && eventType === "delivered") await markDelivered(String(recipient.id), occurredAt);
    return { accepted: inserted.inserted, duplicate: !inserted.inserted };
  },

  async recordTrackedClick(rawTrackingToken: string, userAgent: string | null): Promise<void> {
    const { data: recipient, error } = await supabaseAdmin.from("campaign_recipients").select("*")
      .eq("booking_tracking_token_hash", hashToken(rawTrackingToken)).maybeSingle();
    handleSupabaseError(error, "Unable to find campaign recipient for tracked click");
    if (!recipient) return;
    await insertEvent({
      campaign_id: recipient.campaign_id,
      campaign_recipient_id: recipient.id,
      user_id: recipient.user_id,
      provider: "campaign_redirect",
      provider_event_id: `redirect-${randomUUID()}`,
      provider_message_id: recipient.provider_message_id ?? null,
      event_type: "clicked",
      occurred_at: new Date().toISOString(),
      url: null,
      is_automated: isAutomatedUserAgent(userAgent),
      privacy_limited: false,
      provider_payload: null
    });
  },

  assertValidResendWebhook(rawBody: Buffer | undefined, headers: { id?: string; timestamp?: string; signature?: string }, secret?: string): void {
    if (!rawBody || !secret || !verifyResendWebhookSignature(rawBody, headers, secret)) {
      throw new ApiError(401, "Invalid provider webhook signature");
    }
  }
};
