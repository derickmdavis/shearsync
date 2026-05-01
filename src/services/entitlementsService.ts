import { ApiError } from "../lib/errors";
import {
  DEFAULT_PLAN_STATUS,
  DEFAULT_PLAN_TIER,
  isPlanStatus,
  isPlanTier,
  PLAN_CONFIG,
  type PlanFeatureKey,
  type PlanStatus,
  type PlanTier,
  type UserEntitlements
} from "../lib/plans";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const toWholeNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const normalizePlanTier = (value: unknown): PlanTier => (isPlanTier(value) ? value : DEFAULT_PLAN_TIER);
const normalizePlanStatus = (value: unknown): PlanStatus => (isPlanStatus(value) ? value : DEFAULT_PLAN_STATUS);

const toEntitlements = (user: Row | null): UserEntitlements => {
  const tier = normalizePlanTier(user?.plan_tier);
  const status = normalizePlanStatus(user?.plan_status);
  const config = PLAN_CONFIG[tier];
  const smsUsedThisMonth = toWholeNumber(user?.sms_used_this_month, 0);
  const smsMonthlyLimit = toWholeNumber(user?.sms_monthly_limit, config.smsMonthlyLimit);

  return {
    tier,
    status,
    displayName: config.displayName,
    smsMonthlyLimit,
    smsUsedThisMonth,
    smsRemainingThisMonth: Math.max(0, smsMonthlyLimit - smsUsedThisMonth),
    features: config.features
  };
};

export const entitlementsService = {
  async getPlanForUser(userId: string): Promise<{
    tier: PlanTier;
    status: PlanStatus;
    smsMonthlyLimit: number;
    smsUsedThisMonth: number;
  }> {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("plan_tier, plan_status, sms_monthly_limit, sms_used_this_month")
      .eq("id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load user plan");
    const entitlements = toEntitlements((data as Row | null) ?? null);

    return {
      tier: entitlements.tier,
      status: entitlements.status,
      smsMonthlyLimit: entitlements.smsMonthlyLimit,
      smsUsedThisMonth: entitlements.smsUsedThisMonth
    };
  },

  async getEntitlementsForUser(userId: string): Promise<UserEntitlements> {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("plan_tier, plan_status, sms_monthly_limit, sms_used_this_month")
      .eq("id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load user entitlements");
    return toEntitlements((data as Row | null) ?? null);
  },

  async assertFeatureAllowed(userId: string, featureKey: PlanFeatureKey): Promise<void> {
    const entitlements = await this.getEntitlementsForUser(userId);

    if (entitlements.status === "cancelled") {
      throw new ApiError(403, "This feature is not available for the current plan.");
    }

    // For now, past_due continues to behave like active/trialing until billing policy is finalized.
    if (!entitlements.features[featureKey]) {
      throw new ApiError(403, "This feature is not available for the current plan.");
    }
  },

  async assertSmsAvailable(userId: string, quantity = 1): Promise<void> {
    const entitlements = await this.getEntitlementsForUser(userId);

    if (!entitlements.features.smsReminders || entitlements.smsMonthlyLimit <= 0) {
      throw new ApiError(403, "SMS limit reached for current plan.");
    }

    if (entitlements.smsUsedThisMonth + quantity > entitlements.smsMonthlyLimit) {
      throw new ApiError(403, "SMS limit reached for current plan.");
    }
  },

  async recordUsageEvent(_userId: string, _eventType: string, _quantity: number, _metadata?: Row): Promise<void> {
    // Optional until plan_usage_events exists in the database.
  },

  async updatePlanForUser(
    userId: string,
    updates: {
      tier: PlanTier;
      status?: PlanStatus;
    }
  ): Promise<UserEntitlements> {
    const nextTier = updates.tier;
    const nextStatus = updates.status ?? (await this.getPlanForUser(userId)).status;
    const config = PLAN_CONFIG[nextTier];
    const nowIso = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from("users")
      .update({
        plan_tier: nextTier,
        plan_status: nextStatus,
        sms_monthly_limit: config.smsMonthlyLimit,
        plan_updated_at: nowIso
      })
      .eq("id", userId);

    handleSupabaseError(error, "Unable to update user plan");
    return this.getEntitlementsForUser(userId);
  }
};
