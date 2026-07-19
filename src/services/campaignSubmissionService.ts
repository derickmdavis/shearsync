import { ApiError } from "../lib/errors";
import { randomBytes } from "crypto";
import { env } from "../config/env";
import { hashToken } from "../lib/communications";
import { verifyCampaignValidationToken } from "../lib/campaignValidationToken";
import type { CampaignLinkType } from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import { campaignAudienceEstimateService } from "./campaignAudienceEstimateService";
import { campaignDraftsService } from "./campaignDraftsService";
import { campaignRendererService } from "./campaignRendererService";
import { campaignStoreService } from "./campaignStoreService";
import { handleSupabaseError } from "./db";

const campaignLinkBaseUrl = (): string => env.WEB_APP_URL ?? env.CLIENT_APP_URL ?? "https://campaign-link.pending.invalid";

type SendMode = "now" | "scheduled";
type Draft = Awaited<ReturnType<typeof campaignDraftsService.getForUser>>;

const submissionHash = (draft: Draft): string => hashToken(JSON.stringify({
  revision: draft.revision,
  name: draft.name,
  send_mode: draft.send_mode,
  send_at: draft.send_at,
  timezone: draft.timezone,
  link_type: draft.link_type,
  audience: draft.audience,
  content: draft.content
}));

const getRenderable = (draft: Draft): { subject: string; message: string; linkType: CampaignLinkType } => {
  const { subject, message } = draft.content;
  if (
    typeof subject !== "string" || typeof message !== "string"
    || (draft.link_type !== "booking_link" && draft.link_type !== "referral_link")
  ) {
    throw new ApiError(400, "Campaign submission requires subject, message, and link type");
  }
  return { subject, message, linkType: draft.link_type };
};

const mapSubmissionError = (error: { message?: string; details?: string } | null): never => {
  const message = [error?.message, error?.details].filter((value): value is string => typeof value === "string").join(" ");
  if (message.includes("campaign_revision_conflict")) throw new ApiError(409, "Campaign draft was updated elsewhere");
  if (message.includes("campaign_idempotency_key_reused")) throw new ApiError(409, "Idempotency key was already used with a different request");
  if (message.includes("campaign_idempotency_in_progress")) throw new ApiError(409, "An identical campaign submission is already in progress");
  if (message.includes("campaign_validation_invalid")) throw new ApiError(409, "Campaign validation is invalid, expired, or no longer matches this draft");
  if (message.includes("campaign_not_draft")) throw new ApiError(409, "Campaign has already been submitted");
  if (message.includes("campaign_has_no_eligible_recipients")) throw new ApiError(400, "Campaign has no eligible email recipients");
  if (message.includes("campaign_already_sending")) throw new ApiError(409, "Campaign can no longer be cancelled");
  if (message.includes("campaign_not_cancellable")) throw new ApiError(409, "Campaign is not cancellable");
  if (message.includes("campaign_not_found") || message.includes("campaign_draft_not_found")) throw new ApiError(404, "Campaign not found");
  handleSupabaseError(error as never, "Unable to submit campaign");
  throw new ApiError(500, "Unable to submit campaign");
};

const buildRecipientSnapshots = async (userId: string, draft: Draft) => {
  const renderable = getRenderable(draft);
  const evaluated = await campaignAudienceEstimateService.evaluateForUser(
    userId,
    draft.audience as { mode: "everyone" | "specific"; client_ids: string[] }
  );
  const recipients = evaluated.results.map((result) => {
    const client = evaluated.clients_by_id.get(result.client_id);
    const eligible = result.eligible;
    const trackingToken = eligible ? randomBytes(24).toString("base64url") : null;
    const render = eligible
      ? campaignRendererService.render({
        ...renderable,
        firstName: typeof client?.first_name === "string" ? client.first_name : null,
        links: {
          primary_url: new URL(`/api/public/campaign-links/${trackingToken}`, campaignLinkBaseUrl()).toString(),
          unsubscribe_url: new URL("/api/communications/unsubscribe/pending", campaignLinkBaseUrl()).toString(),
          preferences_url: new URL("/preferences/pending", campaignLinkBaseUrl()).toString()
        }
      })
      : null;
    return {
      client_id: client ? String(client.id) : null,
      recipient_email_snapshot: result.normalized_email,
      first_name_snapshot: typeof client?.first_name === "string" ? client.first_name : null,
      eligibility_status: eligible ? "eligible" : "excluded",
      exclusion_reason: result.reason,
      subject_snapshot: render?.subject ?? null,
      rendered_text_snapshot: render?.text ?? null,
      rendered_html_snapshot: render?.html ?? null,
      render_version: render?.render_version ?? 1,
      booking_tracking_token_hash: trackingToken ? hashToken(trackingToken) : null,
      idempotency_key: client ? `client:${client.id}` : `selection:${result.client_id}`
    };
  });

  return {
    recipients,
    eligible_count: recipients.filter((recipient) => recipient.eligibility_status === "eligible").length,
    excluded_count: recipients.filter((recipient) => recipient.eligibility_status === "excluded").length
  };
};

export const campaignSubmissionService = {
  async submitForUser(input: {
    userId: string;
    campaignId: string;
    revision: number;
    validationToken: string;
    idempotencyKey: string;
    expectedSendMode: SendMode;
  }) {
    const requestHash = hashToken(JSON.stringify({
      campaign_id: input.campaignId,
      revision: input.revision,
      send_mode: input.expectedSendMode
    }));
    const { data: existingIdempotency, error: idempotencyError } = await supabaseAdmin
      .from("campaign_idempotency_records")
      .select("request_hash, response_body, completed_at")
      .eq("user_id", input.userId)
      .eq("scope", "campaign_submit")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    handleSupabaseError(idempotencyError, "Unable to load campaign idempotency record");
    if (existingIdempotency) {
      if (existingIdempotency.request_hash !== requestHash) {
        throw new ApiError(409, "Idempotency key was already used with a different request");
      }
      if (existingIdempotency.completed_at && existingIdempotency.response_body) {
        return existingIdempotency.response_body;
      }
      throw new ApiError(409, "An identical campaign submission is already in progress");
    }

    const rawCampaign = await campaignStoreService.getCampaignForUser(input.userId, input.campaignId);
    const draft = await campaignDraftsService.getForUser(input.userId, input.campaignId);
    if (draft.revision !== input.revision) {
      throw new ApiError(409, "Campaign draft was updated elsewhere", { current_revision: draft.revision }, { exposeDetails: true });
    }
    if (draft.send_mode !== input.expectedSendMode) {
      throw new ApiError(400, `Campaign is configured for ${draft.send_mode === "now" ? "send now" : "scheduled delivery"}`);
    }

    const expectedSubmissionHash = submissionHash(draft);
    const token = verifyCampaignValidationToken(input.validationToken, {
      campaign_id: input.campaignId,
      user_id: input.userId,
      revision: draft.revision,
      submission_hash: expectedSubmissionHash,
      validation_nonce_hash: typeof rawCampaign.validation_nonce_hash === "string" ? rawCampaign.validation_nonce_hash : null
    });
    const snapshots = await buildRecipientSnapshots(input.userId, draft);
    if (snapshots.eligible_count === 0) {
      throw new ApiError(400, "Campaign has no eligible email recipients");
    }

    const { data, error } = await supabaseAdmin.rpc("submit_campaign", {
      p_user_id: input.userId,
      p_campaign_id: input.campaignId,
      p_expected_revision: input.revision,
      p_expected_send_mode: input.expectedSendMode,
      p_validation_nonce_hash: hashToken(token.nonce),
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash,
      p_recipients: snapshots.recipients
    });
    if (error) mapSubmissionError(error);
    for (const recipient of snapshots.recipients) {
      if (!recipient.booking_tracking_token_hash) continue;
      const { error: trackingError } = await supabaseAdmin.from("campaign_recipients").update({
        booking_tracking_token_hash: recipient.booking_tracking_token_hash
      }).eq("campaign_id", input.campaignId).eq("user_id", input.userId).eq("idempotency_key", recipient.idempotency_key);
      handleSupabaseError(trackingError, "Unable to save campaign tracking token");
    }
    return data;
  },

  async cancelForUser(userId: string, campaignId: string, reason?: string | null) {
    const { data, error } = await supabaseAdmin.rpc("cancel_campaign_submission", {
      p_user_id: userId, p_campaign_id: campaignId, p_reason: reason ?? null
    });
    if (error) mapSubmissionError(error);
    return data;
  },

  buildRecipientSnapshots
};
