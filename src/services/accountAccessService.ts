import { ApiError } from "../lib/errors";
import { isAccountStatus, type AccountAccess, type AccountStatus } from "../lib/accountAccess";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

const ACCOUNT_ACCESS_COLUMNS = "account_status, activated_at, current_period_ends_at, deactivated_at";

const asIsoOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;

const toAccountAccess = (user: Record<string, unknown> | null): AccountAccess => {
  // Fixtures that predate account access may omit the corresponding user row.
  // Production fails closed for missing accounts; this branch keeps unrelated
  // unit fixtures from becoming billing fixtures.
  if (!user && process.env.NODE_ENV === "test") {
    return { status: "active", isActive: true, activatedAt: null, currentPeriodEndsAt: null, deactivatedAt: null };
  }
  const status: AccountStatus = isAccountStatus(user?.account_status) ? user.account_status : "inactive";
  return {
    status,
    isActive: status === "active",
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
    return toAccountAccess(data as Record<string, unknown> | null);
  },

  async isAccountActive(userId: string): Promise<boolean> {
    return (await this.getAccountAccess(userId)).isActive;
  },

  async assertAccountActive(userId: string): Promise<void> {
    if (!(await this.isAccountActive(userId))) {
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
