import { CAMPAIGN_RECIPIENT_EXCLUSION_REASONS, type CampaignAudienceMode } from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import { campaignAudienceEligibilityService } from "./campaignAudienceEligibilityService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const CLIENT_COLUMNS = "id, user_id, first_name, email, deleted_at";
const BATCH_SIZE = 500;

const loadEveryone = async (userId: string): Promise<Row[]> => {
  const rows: Row[] = [];
  for (let start = 0; ; start += BATCH_SIZE) {
    const { data, error } = await supabaseAdmin.from("clients").select(CLIENT_COLUMNS)
      .eq("user_id", userId).is("deleted_at", null).order("id", { ascending: true })
      .range(start, start + BATCH_SIZE - 1);
    handleSupabaseError(error, "Unable to load campaign audience");
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < BATCH_SIZE) return rows;
  }
};

const loadSpecific = async (userId: string, clientIds: string[]): Promise<{ clients: Row[]; missingIds: string[] }> => {
  const clients: Row[] = [];
  for (let index = 0; index < clientIds.length; index += BATCH_SIZE) {
    const ids = clientIds.slice(index, index + BATCH_SIZE);
    const { data, error } = await supabaseAdmin.from("clients").select(CLIENT_COLUMNS)
      .eq("user_id", userId).in("id", ids);
    handleSupabaseError(error, "Unable to load selected campaign audience");
    clients.push(...((data ?? []) as Row[]));
  }
  const found = new Set(clients.map((client) => String(client.id)));
  return { clients, missingIds: clientIds.filter((id) => !found.has(id)) };
};

export const campaignAudienceEstimateService = {
  async evaluateForUser(
    userId: string,
    audience: { mode: CampaignAudienceMode; client_ids: string[] }
  ) {
    const loaded = audience.mode === "everyone"
      ? { clients: await loadEveryone(userId), missingIds: [] }
      : await loadSpecific(userId, audience.client_ids);
    const eligibility = await campaignAudienceEligibilityService.evaluateClients(userId, loaded.clients);
    const byId = new Map(eligibility.map((result) => [result.client_id, result]));
    const selectedResults = audience.mode === "specific"
      ? audience.client_ids.map((clientId) => byId.get(clientId) ?? {
        client_id: clientId,
        eligible: false,
        reason: "not_owned_or_not_found" as const,
        normalized_email: null
      })
      : eligibility;

    return {
      clients_by_id: new Map(loaded.clients.map((client) => [String(client.id), client])),
      results: selectedResults
    };
  },

  async estimateForUser(
    userId: string,
    audience: { mode: CampaignAudienceMode; client_ids: string[] },
    now = new Date()
  ) {
    const evaluated = await this.evaluateForUser(userId, audience);
    const selectedResults = evaluated.results;
    const exclusions = Object.fromEntries(CAMPAIGN_RECIPIENT_EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<string, number>;
    for (const result of selectedResults) {
      if (result.reason) exclusions[result.reason] += 1;
    }
    return {
      audience_mode: audience.mode,
      total_count: selectedResults.length,
      eligible_count: selectedResults.filter((result) => result.eligible).length,
      excluded_count: selectedResults.filter((result) => !result.eligible).length,
      exclusions,
      evaluated_at: now.toISOString(),
      ...(audience.mode === "specific" ? {
        selections: selectedResults.map(({ client_id, eligible, reason }) => ({ client_id, eligible, reason }))
      } : {})
    };
  }
};
