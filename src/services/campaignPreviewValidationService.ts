import { randomBytes } from "crypto";
import { ApiError } from "../lib/errors";
import { hashToken } from "../lib/communications";
import { createCampaignValidationToken, CAMPAIGN_VALIDATION_TOKEN_TTL_SECONDS } from "../lib/campaignValidationToken";
import { CAMPAIGN_MISSING_FIRST_NAME_FALLBACK, type CampaignLinkType } from "../lib/outreachContracts";
import { campaignAudienceEstimateService } from "./campaignAudienceEstimateService";
import { campaignDraftsService } from "./campaignDraftsService";
import { campaignRendererService } from "./campaignRendererService";
import { handleSupabaseError } from "./db";
import { supabaseAdmin } from "../lib/supabase";
import { campaignContentSchema, campaignDraftSetupSchema, createCampaignScheduleAtSchema } from "../validators/outreachValidators";

const PREVIEW_BASE_URL = "https://preview.invalid";
const PREVIEW_FIRST_NAME = "Sara";

type Draft = Awaited<ReturnType<typeof campaignDraftsService.getForUser>>;
type FieldError = { field: string; message: string };

const previewLinks = (linkType: CampaignLinkType) => ({
  primary_url: `${PREVIEW_BASE_URL}/campaign/${linkType === "booking_link" ? "book" : "refer"}`,
  unsubscribe_url: `${PREVIEW_BASE_URL}/communications/unsubscribe/example`,
  preferences_url: `${PREVIEW_BASE_URL}/communications/preferences/example`
});

const toFieldErrors = (result: { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }): FieldError[] =>
  result.error.issues.map((issue) => ({ field: issue.path.join(".") || "draft", message: issue.message }));

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

const requireRenderable = (draft: Draft): { subject: string; message: string; linkType: CampaignLinkType } => {
  const subject = draft.content.subject;
  const message = draft.content.message;
  const linkType = draft.link_type;
  if (typeof subject !== "string" || typeof message !== "string" || !["booking_link", "referral_link"].includes(String(linkType))) {
    throw new ApiError(400, "Campaign preview requires subject, message, and link type");
  }
  return { subject, message, linkType: linkType as CampaignLinkType };
};

export const campaignPreviewValidationService = {
  async previewForUser(userId: string, campaignId: string, firstName?: string | null) {
    const draft = await campaignDraftsService.getForUser(userId, campaignId);
    const renderable = requireRenderable(draft);
    const sample = campaignRendererService.render({ ...renderable, firstName: firstName ?? PREVIEW_FIRST_NAME, links: previewLinks(renderable.linkType) });
    const missingNameSample = campaignRendererService.render({ ...renderable, firstName: null, links: previewLinks(renderable.linkType) });
    return {
      campaign_id: draft.id,
      revision: draft.revision,
      sample,
      missing_name_sample: missingNameSample,
      warnings: [
        "Preview links are non-deliverable examples; no production booking, referral, unsubscribe, or preference link was created.",
        `Recipients without a first name receive the neutral fallback “${CAMPAIGN_MISSING_FIRST_NAME_FALLBACK}”.`
      ]
    };
  },

  async validateForUser(userId: string, campaignId: string, expectedRevision: number, now = new Date()) {
    const draft = await campaignDraftsService.getForUser(userId, campaignId);
    if (draft.revision !== expectedRevision) {
      throw new ApiError(409, "Campaign draft was updated elsewhere", { current_revision: draft.revision }, { exposeDetails: true });
    }

    const fieldErrors: FieldError[] = [];
    const setup = campaignDraftSetupSchema.safeParse({
      name: draft.name,
      campaign_kind: draft.campaign_kind,
      send_mode: draft.send_mode,
      send_at: draft.send_at,
      timezone: draft.timezone,
      link_type: draft.link_type,
      audience: draft.audience
    });
    if (!setup.success) fieldErrors.push(...toFieldErrors(setup));

    const content = campaignContentSchema.safeParse(draft.content);
    if (!content.success) {
      fieldErrors.push(...toFieldErrors(content).map((error) => ({ ...error, field: `content.${error.field}` })));
    }

    if (draft.send_mode === "scheduled" && draft.send_at) {
      const schedule = createCampaignScheduleAtSchema(now).safeParse(draft.send_at);
      if (!schedule.success) fieldErrors.push(...toFieldErrors(schedule).map((error) => ({ ...error, field: "send_at" })));
    }

    const audience = await campaignAudienceEstimateService.estimateForUser(
      userId,
      draft.audience as { mode: "everyone" | "specific"; client_ids: string[] },
      now
    );
    if (audience.eligible_count === 0) {
      fieldErrors.push({ field: "audience", message: "Campaign has no eligible email recipients" });
    }

    const warnings = audience.excluded_count > 0
      ? [`${audience.excluded_count} recipient${audience.excluded_count === 1 ? " is" : "s are"} excluded from this send.`]
      : [];
    if (fieldErrors.length > 0) {
      return { valid: false, campaign_id: draft.id, revision: draft.revision, field_errors: fieldErrors, audience, warnings, validation_token: null, validation_expires_at: null };
    }

    const nonce = randomBytes(24).toString("base64url");
    const { data, error } = await supabaseAdmin.from("campaigns").update({
      validated_at: now.toISOString(), validation_nonce_hash: hashToken(nonce)
    }).eq("id", draft.id).eq("user_id", userId).eq("status", "draft").eq("revision", draft.revision).select("id").maybeSingle();
    handleSupabaseError(error, "Unable to validate campaign draft");
    if (!data) throw new ApiError(409, "Campaign draft was updated elsewhere", { current_revision: draft.revision }, { exposeDetails: true });

    const token = createCampaignValidationToken({
      campaign_id: String(draft.id), user_id: userId, revision: draft.revision, nonce, submission_hash: submissionHash(draft)
    });
    return {
      valid: true,
      campaign_id: draft.id,
      revision: draft.revision,
      field_errors: [],
      audience,
      warnings,
      validation_token: token,
      validation_expires_at: new Date(now.getTime() + CAMPAIGN_VALIDATION_TOKEN_TTL_SECONDS * 1000).toISOString()
    };
  },

  getSubmissionHash: submissionHash
};
