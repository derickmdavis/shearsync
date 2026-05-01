export type PlanTier = "basic" | "pro" | "premium";
export type PlanStatus = "trialing" | "active" | "past_due" | "cancelled";

export type PlanFeatureKey =
  | "bookingPage"
  | "crm"
  | "emailReminders"
  | "smsReminders"
  | "customCoverPhoto"
  | "customSlug"
  | "googleCalendarSync"
  | "weeklyBusinessRecap"
  | "clientExport";

export interface PlanFeatures {
  bookingPage: boolean;
  crm: boolean;
  emailReminders: boolean;
  smsReminders: boolean;
  customCoverPhoto: boolean;
  customSlug: boolean;
  googleCalendarSync: boolean;
  weeklyBusinessRecap: boolean;
  clientExport: boolean;
}

export interface PlanConfig {
  tier: PlanTier;
  displayName: string;
  smsMonthlyLimit: number;
  features: PlanFeatures;
}

export interface UserEntitlements {
  tier: PlanTier;
  status: PlanStatus;
  displayName: string;
  smsMonthlyLimit: number;
  smsUsedThisMonth: number;
  smsRemainingThisMonth: number;
  features: PlanFeatures;
}

export const PLAN_CONFIG: Record<PlanTier, PlanConfig> = {
  basic: {
    tier: "basic",
    displayName: "Basic",
    smsMonthlyLimit: 0,
    features: {
      bookingPage: true,
      crm: true,
      emailReminders: true,
      smsReminders: false,
      customCoverPhoto: false,
      customSlug: false,
      googleCalendarSync: false,
      weeklyBusinessRecap: false,
      clientExport: false
    }
  },
  pro: {
    tier: "pro",
    displayName: "Pro",
    smsMonthlyLimit: 100,
    features: {
      bookingPage: true,
      crm: true,
      emailReminders: true,
      smsReminders: true,
      customCoverPhoto: true,
      customSlug: false,
      googleCalendarSync: false,
      weeklyBusinessRecap: false,
      clientExport: false
    }
  },
  premium: {
    tier: "premium",
    displayName: "Premium",
    smsMonthlyLimit: 300,
    features: {
      bookingPage: true,
      crm: true,
      emailReminders: true,
      smsReminders: true,
      customCoverPhoto: true,
      customSlug: true,
      googleCalendarSync: true,
      weeklyBusinessRecap: true,
      clientExport: true
    }
  }
};

export const DEFAULT_PLAN_TIER: PlanTier = "basic";
export const DEFAULT_PLAN_STATUS: PlanStatus = "active";

export const isPlanTier = (value: unknown): value is PlanTier =>
  value === "basic" || value === "pro" || value === "premium";

export const isPlanStatus = (value: unknown): value is PlanStatus =>
  value === "trialing" || value === "active" || value === "past_due" || value === "cancelled";
