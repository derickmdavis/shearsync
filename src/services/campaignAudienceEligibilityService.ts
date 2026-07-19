import { normalizeEmail } from "../lib/communications";
import type { CampaignRecipientExclusionReason } from "../lib/outreachContracts";
import { communicationPreferencesService } from "./communicationPreferences";
import type { Row } from "./db";

export interface CampaignClientEligibility {
  client_id: string;
  eligible: boolean;
  reason: CampaignRecipientExclusionReason | null;
  normalized_email: string | null;
}

const isValidEmail = (value: string): boolean =>
  value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const mapPreferenceReason = (reason: string | undefined): CampaignRecipientExclusionReason => {
  if (reason === "global_unsubscribe") return "globally_unsubscribed";
  if (reason === "missing_contact") return "missing_email";
  return "email_marketing_disabled";
};

export const campaignAudienceEligibilityService = {
  async evaluateClients(
    userId: string,
    clients: Row[],
    options: { applyDuplicateExclusions?: boolean } = {}
  ): Promise<CampaignClientEligibility[]> {
    const results = new Map<string, CampaignClientEligibility>();
    const candidates: Array<{
      id: string;
      clientId: string;
      channel: "email";
      to: string;
      messageType: "marketing";
      requireExplicitMarketingConsent: true;
    }> = [];

    for (const client of clients) {
      const clientId = String(client.id);
      const normalizedEmail = normalizeEmail(client.email);
      let reason: CampaignRecipientExclusionReason | null = null;
      if (client.deleted_at) reason = "client_deleted";
      else if (!normalizedEmail) reason = "missing_email";
      else if (!isValidEmail(normalizedEmail)) reason = "invalid_email";

      results.set(clientId, { client_id: clientId, eligible: reason === null, reason, normalized_email: normalizedEmail });
      if (!reason && normalizedEmail) {
        candidates.push({
          id: clientId,
          clientId,
          channel: "email",
          to: normalizedEmail,
          messageType: "marketing",
          requireExplicitMarketingConsent: true
        });
      }
    }

    const preferences = await communicationPreferencesService.canSendCommunicationsReadOnly(userId, candidates);
    for (const candidate of candidates) {
      const preference = preferences.get(candidate.id);
      if (preference && !preference.canSend) {
        results.set(candidate.id, {
          client_id: candidate.id,
          eligible: false,
          reason: mapPreferenceReason(preference.reason),
          normalized_email: candidate.to
        });
      }
    }

    if (options.applyDuplicateExclusions !== false) {
      const eligibleByEmail = new Map<string, CampaignClientEligibility[]>();
      for (const result of results.values()) {
        if (!result.eligible || !result.normalized_email) continue;
        const group = eligibleByEmail.get(result.normalized_email) ?? [];
        group.push(result);
        eligibleByEmail.set(result.normalized_email, group);
      }
      for (const group of eligibleByEmail.values()) {
        group.sort((left, right) => left.client_id.localeCompare(right.client_id));
        for (const duplicate of group.slice(1)) {
          duplicate.eligible = false;
          duplicate.reason = "duplicate_recipient";
        }
      }
    }

    return clients.map((client) => results.get(String(client.id)) as CampaignClientEligibility);
  }
};
