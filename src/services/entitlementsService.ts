import { ALL_ACCOUNT_FEATURES, type AccountCapabilities, type AccountFeatureKey } from "../lib/accountCapabilities";
import { accountAccessService } from "./accountAccessService";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

/** Transitional facade: every capability is included for an active account. */
export const entitlementsService = {
  async getEntitlementsForUser(userId: string): Promise<AccountCapabilities> {
    const [{ data, error }, access] = await Promise.all([
      supabaseAdmin.from("users").select("waitlist_enabled").eq("id", userId).maybeSingle(),
      accountAccessService.getAccountAccess(userId)
    ]);
    handleSupabaseError(error, "Unable to load account capabilities");
    const waitlistEnabled = data?.waitlist_enabled !== false;
    return {
      status: access.status,
      features: ALL_ACCOUNT_FEATURES,
      settings: { waitlistEnabled },
      effectiveFeatures: { waitlistEnabled: access.isActive && waitlistEnabled }
    };
  },

  async assertFeatureAllowed(userId: string, _featureKey: AccountFeatureKey): Promise<void> {
    await accountAccessService.assertAccountActive(userId);
  },

  async isFeatureAllowed(userId: string, _featureKey: AccountFeatureKey): Promise<boolean> {
    return accountAccessService.isAccountActive(userId);
  },

  async assertSmsAvailable(userId: string, _quantity = 1): Promise<void> {
    await accountAccessService.assertAccountActive(userId);
  },

  async recordUsageEvent(_userId: string, _eventType: string, _quantity: number, _metadata?: Record<string, unknown>): Promise<void> {
    // SMS is no longer tier-metered. Retained only for call-site compatibility.
  }
};
