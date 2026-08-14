import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

export interface SmsDeliveryStatusOptions {
  messageSid?: string | null;
  messageStatus?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  to?: string | null;
  providerDiagnostics?: Row | null;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const safeProviderMessage = (value: unknown): string | null => {
  const message = text(value)
    ?.replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\b(?:AC|SK)[a-zA-Z0-9]{32}\b/g, "[redacted-credential]")
    .replace(/\+?\d[\d().\s-]{6,}\d/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .slice(0, 500) ?? null;
  return message || null;
};
const safeErrorCode = (value: unknown): string | null => {
  const code = text(value);
  return code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? `twilio_${code}` : null;
};

/**
 * Applies and audits one Twilio delivery-status transition atomically in Postgres.
 * Unknown timeout outcomes reject late intermediate states but can reconcile to final delivered/failed.
 */
export const smsDeliveryStatusService = {
  async applyTwilioStatus(options: SmsDeliveryStatusOptions): Promise<{ updated: boolean }> {
    const messageSid = text(options.messageSid);
    const messageStatus = text(options.messageStatus)?.toLowerCase();
    if (!messageSid || !messageStatus) return { updated: false };

    const diagnostics = options.providerDiagnostics && typeof options.providerDiagnostics === "object" ? options.providerDiagnostics : {};
    const { data, error } = await supabaseAdmin.rpc("apply_twilio_sms_delivery_status", {
      p_provider_message_id: messageSid,
      p_message_status: messageStatus,
      p_error_code: safeErrorCode(options.errorCode),
      p_error_message: safeProviderMessage(options.errorMessage),
      p_to: text(options.to),
      p_diagnostics: diagnostics
    });
    handleSupabaseError(error, "Unable to apply Twilio SMS delivery status");
    const result = Array.isArray(data) ? data[0] : data;
    return { updated: result?.updated === true };
  }
};
