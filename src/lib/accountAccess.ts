export type AccountStatus = "active" | "inactive";

export interface AccountAccess {
  status: AccountStatus;
  isActive: boolean;
  deletionStatus: "active" | "pending" | "processing" | "failed";
  activatedAt: string | null;
  currentPeriodEndsAt: string | null;
  deactivatedAt: string | null;
}

export const isAccountStatus = (value: unknown): value is AccountStatus =>
  value === "active" || value === "inactive";
