import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { campaignStoreService } from "./campaignStoreService";

type DraftPatch = {
  revision: number;
  name?: string | null;
  send_mode?: "now" | "scheduled";
  send_at?: string | null;
  timezone?: string;
  link_type?: "booking_link" | "referral_link" | null;
  template_id?: string | null;
  audience?: { mode: "everyone" | "specific"; client_ids: string[] };
  content?: { subject?: string | null; message?: string | null };
};

const mapRpcError = (error: { message?: string; details?: string } | null): never => {
  if (error?.message?.includes("campaign_revision_conflict")) {
    let currentRevision: number | null = null;
    try {
      const parsed = JSON.parse(error.details ?? "{}") as { current_revision?: number };
      currentRevision = parsed.current_revision ?? null;
    } catch { /* retain neutral conflict detail */ }
    throw new ApiError(409, "Campaign draft was updated elsewhere", { current_revision: currentRevision }, { exposeDetails: true });
  }
  if (error?.message?.includes("campaign_template_not_found")) throw new ApiError(404, "Campaign template not found");
  if (error?.message?.includes("campaign_draft_not_found")) throw new ApiError(404, "Campaign draft not found");
  if (error?.message?.includes("campaign_audience_client_not_owned")) throw new ApiError(400, "One or more selected clients are invalid");
  handleSupabaseError(error as never, "Unable to save campaign draft");
  throw new ApiError(500, "Unable to save campaign draft");
};

const toDraft = async (userId: string, row: Row) => {
  if (row.status !== "draft") throw new ApiError(404, "Campaign draft not found");
  const { data, error } = await supabaseAdmin
    .from("campaign_audience_selections")
    .select("client_id")
    .eq("user_id", userId)
    .eq("campaign_id", row.id)
    .order("created_at", { ascending: true });
  handleSupabaseError(error, "Unable to load campaign audience selections");
  return {
    id: row.id,
    status: "draft" as const,
    campaign_kind: "one_time" as const,
    revision: Number(row.revision),
    name: row.name ?? null,
    send_mode: row.send_mode,
    send_at: row.scheduled_for ?? null,
    timezone: row.timezone_snapshot,
    link_type: row.link_type ?? null,
    template_id: row.template_id ?? null,
    template_version: row.template_version === null || row.template_version === undefined ? null : Number(row.template_version),
    audience: {
      mode: row.audience_mode,
      client_ids: ((data ?? []) as Row[]).map((selection) => String(selection.client_id))
    },
    content: { subject: row.subject_snapshot ?? null, message: row.message_snapshot ?? null },
    created_at: row.created_at,
    updated_at: row.updated_at
  };
};

export const campaignDraftsService = {
  async createForUser(userId: string, templateId?: string | null) {
    const timezone = await businessTimeZoneService.getForUser(userId);
    const { data, error } = await supabaseAdmin.rpc("create_campaign_draft", {
      p_user_id: userId, p_timezone: timezone, p_template_id: templateId ?? null
    });
    if (error) mapRpcError(error);
    return toDraft(userId, data as Row);
  },

  async getForUser(userId: string, campaignId: string) {
    return toDraft(userId, await campaignStoreService.getCampaignForUser(userId, campaignId));
  },

  async updateForUser(userId: string, campaignId: string, patch: DraftPatch) {
    const content = patch.content ?? {};
    const { data, error } = await supabaseAdmin.rpc("update_campaign_draft", {
      p_user_id: userId,
      p_campaign_id: campaignId,
      p_expected_revision: patch.revision,
      p_has_name: "name" in patch,
      p_name: patch.name ?? null,
      p_has_send_mode: "send_mode" in patch,
      p_send_mode: patch.send_mode ?? null,
      p_has_scheduled_for: "send_at" in patch,
      p_scheduled_for: patch.send_at ?? null,
      p_has_timezone: "timezone" in patch,
      p_timezone: patch.timezone ?? null,
      p_has_link_type: "link_type" in patch,
      p_link_type: patch.link_type ?? null,
      p_has_template: "template_id" in patch,
      p_template_id: patch.template_id ?? null,
      p_has_subject: "subject" in content,
      p_subject: content.subject ?? null,
      p_has_message: "message" in content,
      p_message: content.message ?? null,
      p_has_audience: "audience" in patch,
      p_audience_mode: patch.audience?.mode ?? null,
      p_client_ids: patch.audience?.client_ids ?? []
    });
    if (error) mapRpcError(error);
    return toDraft(userId, data as Row);
  },

  async deleteForUser(userId: string, campaignId: string): Promise<void> {
    const { data, error } = await supabaseAdmin.from("campaigns").delete()
      .eq("user_id", userId).eq("id", campaignId).eq("status", "draft").select("id").maybeSingle();
    handleSupabaseError(error, "Unable to delete campaign draft");
    if (!data) throw new ApiError(404, "Campaign draft not found");
  }
};
