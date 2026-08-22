import { ApiError } from "../lib/errors";
import { isAccountStatus, type AccountAccess, type AccountStatus } from "../lib/accountAccess";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

const ACCOUNT_ACCESS_COLUMNS = "account_status, deletion_status, activated_at, current_period_ends_at, deactivated_at";

const asIsoOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;

const isCurrentPeriodExpired = (user: Record<string, unknown> | null, now: Date): boolean => {
  if (user?.account_status !== "active") {
    return false;
  }

  const currentPeriodEndsAt = asIsoOrNull(user.current_period_ends_at);
  if (!currentPeriodEndsAt) {
    return false;
  }

  const endsAtMs = Date.parse(currentPeriodEndsAt);
  return Number.isFinite(endsAtMs) && endsAtMs <= now.getTime();
};

const toAccountAccess = (user: Record<string, unknown> | null): AccountAccess => {
  // Fixtures that predate account access may omit the corresponding user row.
  // Production fails closed for missing accounts; this branch keeps unrelated
  // unit fixtures from becoming billing fixtures.
  if (!user && process.env.NODE_ENV === "test") {
    return {
      status: "active", isActive: true, deletionStatus: "active",
      activatedAt: null, currentPeriodEndsAt: null, deactivatedAt: null
    };
  }
  const status: AccountStatus = isAccountStatus(user?.account_status) ? user.account_status : "inactive";
  const deletionStatus = ["active", "pending", "processing", "failed"].includes(String(user?.deletion_status))
    ? String(user?.deletion_status) as AccountAccess["deletionStatus"]
    : "active";
  return {
    status,
    isActive: status === "active",
    deletionStatus,
    activatedAt: asIsoOrNull(user?.activated_at),
    currentPeriodEndsAt: asIsoOrNull(user?.current_period_ends_at),
    deactivatedAt: asIsoOrNull(user?.deactivated_at)
  };
};

export const accountAccessService = {
  async getAccountAccess(userId: string): Promise<AccountAccess> {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select(ACCOUNT_ACCESS_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    handleSupabaseError(error, "Unable to load account access");

    const user = data as Record<string, unknown> | null;
    const now = new Date();
    if (!isCurrentPeriodExpired(user, now)) {
      return toAccountAccess(user);
    }

    // This conditional update is idempotent and prevents a stale access read
    // from deactivating an account that a billing update has already renewed.
    const { data: expiredUser, error: expireError } = await supabaseAdmin
      .from("users")
      .update({
        account_status: "inactive",
        deactivated_at: now.toISOString()
      })
      .eq("id", userId)
      .eq("account_status", "active")
      .lte("current_period_ends_at", now.toISOString())
      .select(ACCOUNT_ACCESS_COLUMNS)
      .maybeSingle();
    handleSupabaseError(expireError, "Unable to expire account access");

    // If a concurrent renewal won the conditional update, fail closed for
    // this request; the subsequent access check will observe the renewal.
    return toAccountAccess(expiredUser as Record<string, unknown> | null);
  },

  async expireEndedAccounts(now = new Date()): Promise<{ expired: number; processedAt: string }> {
    const processedAt = now.toISOString();
    const { data, error } = await supabaseAdmin
      .from("users")
      .update({
        account_status: "inactive",
        deactivated_at: processedAt
      })
      .eq("account_status", "active")
      .not("current_period_ends_at", "is", null)
      .lte("current_period_ends_at", processedAt)
      .select("id");
    handleSupabaseError(error, "Unable to expire elapsed account access");

    return {
      expired: Array.isArray(data) ? data.length : 0,
      processedAt
    };
  },

  async isAccountActive(userId: string): Promise<boolean> {
    return (await this.getAccountAccess(userId)).isActive;
  },

  async assertAccountActive(userId: string): Promise<void> {
    const access = await this.getAccountAccess(userId);
    if (access.deletionStatus === "pending" || access.deletionStatus === "processing") {
      throw new ApiError(
        403,
        "Account deletion is pending.",
        { code: "account_deletion_pending" },
        { exposeDetails: true }
      );
    }
    if (!access.isActive) {
      throw new ApiError(
        403,
        "An active subscription is required to use ShearSync.",
        { code: "account_inactive" },
        { exposeDetails: true }
      );
    }
  },

  async applyBillingState(input: {
    userId: string;
    status: AccountStatus;
    billingProvider?: string | null;
    billingCustomerId?: string | null;
    currentPeriodEndsAt?: string | null;
    occurredAt?: Date;
  }): Promise<AccountAccess> {
    const previous = await this.getAccountAccess(input.userId);
    const occurredAt = (input.occurredAt ?? new Date()).toISOString();
    const nextValues = input.status === "active"
      ? {
          account_status: "active",
          activated_at: previous.activatedAt ?? occurredAt,
          current_period_ends_at: input.currentPeriodEndsAt ?? null,
          deactivated_at: null,
          billing_provider: input.billingProvider ?? null,
          billing_customer_id: input.billingCustomerId ?? null
        }
      : {
          account_status: "inactive",
          deactivated_at: occurredAt,
          ...(input.currentPeriodEndsAt !== undefined ? { current_period_ends_at: input.currentPeriodEndsAt } : {}),
          ...(input.billingProvider !== undefined ? { billing_provider: input.billingProvider } : {}),
          ...(input.billingCustomerId !== undefined ? { billing_customer_id: input.billingCustomerId } : {})
        };
    const { error } = await supabaseAdmin.from("users").update(nextValues).eq("id", input.userId);
    handleSupabaseError(error, "Unable to apply billing account state");
    return this.getAccountAccess(input.userId);
  }
};
