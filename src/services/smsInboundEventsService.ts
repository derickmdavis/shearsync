import type { TwilioInboundSms } from "../lib/twilioInboundSms";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { randomUUID } from "crypto";

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const leaseMinutes = 2;

export interface InboundSmsClaim {
  claimed: boolean;
  processed: boolean;
  event: Row | null;
  leaseToken?: string;
}

const isLeaseExpired = (event: Row, now: Date): boolean => {
  const expiry = new Date(String(event.lease_expires_at ?? "")).getTime();
  return !Number.isFinite(expiry) || expiry <= now.getTime();
};

/** Claims an inbound Twilio event for processing. Processed events are deduped; failed/stale work is recovered. */
export const smsInboundEventsService = {
  async claimTwilioInboundEvent(event: TwilioInboundSms, now = new Date()): Promise<InboundSmsClaim> {
    const existing = await supabaseAdmin.from("sms_inbound_events").select("*")
      .eq("provider", "twilio").eq("provider_message_id", event.messageSid).maybeSingle();
    handleSupabaseError(existing.error, "Unable to load existing inbound SMS event");
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMinutes * 60_000).toISOString();
    const current = existing.data as Row | null;
    if (current?.status === "processed") return { claimed: false, processed: true, event: current };

    if (current) {
      if (current.status === "processing" && !isLeaseExpired(current, now)) {
        return { claimed: false, processed: false, event: current };
      }
      const { data, error } = await supabaseAdmin.from("sms_inbound_events").update({
        status: "processing", attempt_count: Number(current.attempt_count ?? 0) + 1,
        lease_token: leaseToken, lease_expires_at: leaseExpiresAt, failed_at: null, error_code: null
      }).eq("id", String(current.id)).eq("status", String(current.status)).select("*").maybeSingle();
      handleSupabaseError(error, "Unable to reclaim inbound SMS event");
      return data
        ? { claimed: true, processed: false, event: data as Row, leaseToken }
        : { claimed: false, processed: false, event: current };
    }

    const { data, error } = await supabaseAdmin.from("sms_inbound_events").insert({
      provider: "twilio", provider_message_id: event.messageSid, from_phone: event.from,
      from_phone_normalized: event.fromNormalized, to_phone: event.to, to_phone_normalized: event.toNormalized,
      body: event.body, classification: event.classification, classification_source: event.classificationSource,
      provider_metadata: event.providerMetadata, status: "processing", attempt_count: 1,
      lease_token: leaseToken, lease_expires_at: leaseExpiresAt
    }).select("*").maybeSingle();
    if (!isUniqueViolation(error)) {
      handleSupabaseError(error, "Unable to claim inbound SMS event");
      return { claimed: true, processed: false, event: data as Row | null, leaseToken };
    }
    const duplicate = await supabaseAdmin.from("sms_inbound_events").select("*")
      .eq("provider", "twilio").eq("provider_message_id", event.messageSid).maybeSingle();
    handleSupabaseError(duplicate.error, "Unable to load existing inbound SMS event");
    return { claimed: false, processed: (duplicate.data as Row | null)?.status === "processed", event: duplicate.data as Row | null };
  },

  async markProcessed(eventId: string, leaseToken: string, now = new Date()): Promise<boolean> {
    const { data, error } = await supabaseAdmin.from("sms_inbound_events").update({
      status: "processed", processed_at: now.toISOString(), lease_token: null, lease_expires_at: null
    }).eq("id", eventId).eq("status", "processing").eq("lease_token", leaseToken).select("id").maybeSingle();
    handleSupabaseError(error, "Unable to complete inbound SMS event");
    return Boolean(data);
  },

  async markFailed(eventId: string, leaseToken: string, errorCode = "inbound_processing_failed", now = new Date()): Promise<void> {
    const { error } = await supabaseAdmin.from("sms_inbound_events").update({
      status: "failed", failed_at: now.toISOString(), error_code: errorCode, lease_token: null, lease_expires_at: null
    }).eq("id", eventId).eq("status", "processing").eq("lease_token", leaseToken);
    handleSupabaseError(error, "Unable to mark inbound SMS event failed");
  }
};
