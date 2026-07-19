import { createResendEmailProvider, type EmailProvider } from "./appointmentEmailDeliveryService";
import { communicationPreferencesService } from "./communicationPreferences";
import { handleSupabaseError, type Row } from "./db";
import { supabaseAdmin } from "../lib/supabase";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_CLAIM_MINUTES = 15;

export interface ProcessCampaignDeliveryOptions {
  limit?: number;
  maxAttempts?: number;
  staleClaimAfterMinutes?: number;
  provider?: EmailProvider;
  now?: Date;
}

export interface CampaignDeliveryProcessingResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
  runIds: string[];
}

const getPositiveInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }

  return Math.min(Math.floor(value), maximum);
};

const errorDetails = (error: unknown): { code: string; message: string } => ({
  code: error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 120)
    : "provider_send_failed",
  message: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
});

const getString = (row: Row, field: string): string | null =>
  typeof row[field] === "string" && row[field].trim().length > 0 ? row[field] : null;

const claimRecipients = async (limit: number, staleBefore: Date, maxAttempts: number): Promise<Row[]> => {
  const { data, error } = await supabaseAdmin.rpc("claim_campaign_recipients", {
    p_limit: limit,
    p_stale_before: staleBefore.toISOString(),
    p_max_attempts: maxAttempts
  });

  handleSupabaseError(error, "Unable to claim campaign recipients");
  return (data ?? []) as Row[];
};

const updateClaimedRecipient = async (recipientId: string, payload: Row): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("campaign_recipients")
    .update(payload)
    .eq("id", recipientId)
    .eq("status", "sending");

  handleSupabaseError(error, "Unable to finalize campaign recipient delivery");
};

const campaignCanStillSend = async (campaignId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to verify campaign delivery status");
  return data?.status === "sending" || data?.status === "scheduled";
};

const finalizeRuns = async (runIds: string[], maxAttempts: number): Promise<void> => {
  if (runIds.length === 0) {
    return;
  }

  const { error } = await supabaseAdmin.rpc("finalize_campaign_runs", { p_run_ids: runIds, p_max_attempts: maxAttempts });
  handleSupabaseError(error, "Unable to finalize campaign runs");
};

/**
 * Claims a bounded group of recipients in the database, then processes each one
 * independently. The claim RPC uses row locks, so concurrent workers cannot own
 * the same recipient. A recipient is only retried while it remains below the
 * configured attempt ceiling.
 */
export const campaignDeliveryWorkerService = {
  async processDueCampaigns(options: ProcessCampaignDeliveryOptions = {}): Promise<CampaignDeliveryProcessingResult> {
    const limit = getPositiveInteger(options.limit, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
    const maxAttempts = getPositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 10);
    const staleClaimAfterMinutes = getPositiveInteger(
      options.staleClaimAfterMinutes,
      DEFAULT_STALE_CLAIM_MINUTES,
      24 * 60
    );
    const now = options.now ?? new Date();
    const recipients = await claimRecipients(limit, new Date(now.getTime() - staleClaimAfterMinutes * 60_000), maxAttempts);
    const provider = options.provider ?? createResendEmailProvider();
    const result: CampaignDeliveryProcessingResult = {
      processed: recipients.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      retrying: 0,
      runIds: [...new Set(recipients.map((row) => getString(row, "campaign_run_id")).filter((id): id is string => Boolean(id)))]
    };

    for (const recipient of recipients) {
      const recipientId = getString(recipient, "id");
      const campaignId = getString(recipient, "campaign_id");
      const userId = getString(recipient, "user_id");
      const email = getString(recipient, "recipient_email_snapshot");

      if (!recipientId || !campaignId || !userId || !email) {
        if (recipientId) {
          await updateClaimedRecipient(recipientId, {
            status: "skipped",
            skipped_at: now.toISOString(),
            error_code: "invalid_recipient_snapshot",
            error_message: "The campaign recipient does not have a deliverable email snapshot."
          });
        }
        result.skipped += 1;
        continue;
      }

      // Cancellation wins before the provider is contacted; a claimed campaign
      // normally cannot be cancelled, but this check also protects manual changes.
      if (!await campaignCanStillSend(campaignId)) {
        await updateClaimedRecipient(recipientId, {
          status: "skipped",
          skipped_at: now.toISOString(),
          error_code: "campaign_cancelled",
          error_message: "Campaign was cancelled before this recipient was delivered."
        });
        result.skipped += 1;
        continue;
      }

      const eligibility = await communicationPreferencesService.canSendCommunication({
        userId,
        clientId: getString(recipient, "client_id"),
        channel: "email",
        to: email,
        messageType: "marketing",
        requireExplicitMarketingConsent: true
      });

      if (!eligibility.canSend) {
        await updateClaimedRecipient(recipientId, {
          status: "skipped",
          skipped_at: now.toISOString(),
          error_code: eligibility.reason ?? "communication_not_eligible",
          error_message: "Recipient is no longer eligible for marketing email."
        });
        result.skipped += 1;
        continue;
      }

      if (!provider) {
        await updateClaimedRecipient(recipientId, {
          status: "failed",
          failed_at: now.toISOString(),
          error_code: "email_provider_not_configured",
          error_message: "No email provider is configured for campaign delivery."
        });
        result.failed += 1;
        continue;
      }

      try {
        const response = await provider.send({
          to: email,
          subject: getString(recipient, "subject_snapshot") ?? "",
          text: getString(recipient, "rendered_text_snapshot") ?? "",
          html: getString(recipient, "rendered_html_snapshot") ?? "",
          idempotencyKey: getString(recipient, "idempotency_key") ?? undefined
        });

        if (response.status === "sent") {
          await updateClaimedRecipient(recipientId, {
            status: "sent",
            sent_at: now.toISOString(),
            provider: response.provider,
            provider_message_id: response.providerMessageId ?? null,
            error_code: null,
            error_message: null
          });
          result.sent += 1;
        } else {
          await updateClaimedRecipient(recipientId, {
            status: "skipped",
            skipped_at: now.toISOString(),
            provider: response.provider,
            error_code: "provider_skipped",
            error_message: (response.error ?? "Provider skipped this delivery.").slice(0, 2000)
          });
          result.skipped += 1;
        }
      } catch (error) {
        const details = errorDetails(error);
        const attempts = typeof recipient.attempt_count === "number" ? recipient.attempt_count : 1;
        await updateClaimedRecipient(recipientId, {
          status: "failed",
          failed_at: now.toISOString(),
          error_code: details.code,
          error_message: details.message
        });
        result.failed += 1;
        if (attempts < maxAttempts) {
          result.retrying += 1;
        }
      }
    }

    await finalizeRuns(result.runIds, maxAttempts);
    return result;
  }
};
