import { requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

// All campaign persistence access starts from an authenticated owner scope.
// Later campaign services should use these helpers instead of querying by id alone.
export const campaignStoreService = {
  async getCampaignForUser(userId: string, campaignId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("user_id", userId)
      .eq("id", campaignId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load campaign");
    return requireFound(data as Row | null, "Campaign not found");
  },

  async getRunForUser(userId: string, campaignId: string, runId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("campaign_runs")
      .select("*")
      .eq("user_id", userId)
      .eq("campaign_id", campaignId)
      .eq("id", runId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load campaign run");
    return requireFound(data as Row | null, "Campaign run not found");
  }
};
