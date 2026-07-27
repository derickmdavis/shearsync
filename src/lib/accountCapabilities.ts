import type { AccountStatus } from "./accountAccess";

export type AccountFeatureKey =
  | "bookingPage" | "crm" | "emailReminders" | "emailCampaigns" | "smsReminders"
  | "waitlist" | "appointmentPhotos" | "rebookNudges" | "birthdayReminders"
  | "thankYouEmails" | "referrals" | "waitlistMatch" | "noShowFollowUp"
  | "customCoverPhoto" | "customSlug" | "googleCalendarSync" | "weeklyBusinessRecap"
  | "clientExport";

export type AccountFeatures = Record<AccountFeatureKey, true>;

export interface AccountCapabilities {
  status: AccountStatus;
  features: AccountFeatures;
  settings: { waitlistEnabled: boolean };
  effectiveFeatures: { waitlistEnabled: boolean };
}

export const ALL_ACCOUNT_FEATURES: AccountFeatures = {
  bookingPage: true, crm: true, emailReminders: true, emailCampaigns: true,
  smsReminders: true, waitlist: true, appointmentPhotos: true, rebookNudges: true,
  birthdayReminders: true, thankYouEmails: true, referrals: true, waitlistMatch: true,
  noShowFollowUp: true, customCoverPhoto: true, customSlug: true,
  googleCalendarSync: true, weeklyBusinessRecap: true, clientExport: true
};
