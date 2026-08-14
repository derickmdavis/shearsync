import { env } from "../config/env";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

export interface SmsInboundEventRetentionResult {
  retentionDays: number;
  cutoff: string;
  redacted: number;
}

/** Redacts raw inbound SMS bodies and phone data while preserving event/audit linkage. */
export const smsInboundEventRetentionService = {
  async cleanup(retentionDays = env.SMS_INBOUND_EVENT_RETENTION_DAYS): Promise<SmsInboundEventRetentionResult> {
    const normalizedRetentionDays = Math.max(1, Math.floor(retentionDays));
    const cutoff = new Date(Date.now() - normalizedRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin.from("sms_inbound_events")
      .update({
        from_phone: null,
        from_phone_normalized: null,
        to_phone: null,
        to_phone_normalized: null,
        body: null,
        provider_metadata: { retention_redacted: true },
        redacted_at: new Date().toISOString()
      })
      .in("status", ["processed", "failed"])
      .is("redacted_at", null)
      .lt("received_at", cutoff)
      .select("id");
    handleSupabaseError(error, "Unable to redact retained inbound SMS events");
    return { retentionDays: normalizedRetentionDays, cutoff, redacted: Array.isArray(data) ? data.length : 0 };
  }
};
