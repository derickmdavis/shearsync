import { createHash, randomBytes } from "crypto";
import { normalizePhone as normalizePhoneNumber } from "./phone";

export const communicationChannels = ["email", "sms"] as const;
export type CommunicationChannel = typeof communicationChannels[number];

export const messageTypes = [
  "appointment_confirmation",
  "appointment_reminder",
  "appointment_cancelled",
  "appointment_rescheduled",
  "waitlist_update",
  "rebooking_prompt",
  "marketing",
  "business_recap"
] as const;
export type MessageType = typeof messageTypes[number];

export const communicationEventStatuses = [
  "queued",
  "sent",
  "delivered",
  "failed",
  "skipped_opted_out",
  "skipped_missing_consent",
  "bounced",
  "complained",
  "unsubscribed",
  "inbound_stop",
  "inbound_start",
  "inbound_help"
] as const;
export type CommunicationEventStatus = typeof communicationEventStatuses[number];

export const consentEventTypes = [
  "opted_in",
  "opted_out",
  "opted_back_in",
  "preference_updated",
  "inbound_stop",
  "inbound_start",
  "inbound_help",
  "unsubscribe_link_clicked",
  "admin_updated",
  "imported"
] as const;
export type ConsentEventType = typeof consentEventTypes[number];

export const consentSources = [
  "booking_page",
  "admin",
  "unsubscribe_link",
  "inbound_sms",
  "manual",
  "import",
  "client_portal",
  "system"
] as const;
export type ConsentSource = typeof consentSources[number];

export const tokenActions = ["unsubscribe", "manage_preferences", "sms_opt_in", "sms_opt_out"] as const;
export type CommunicationPreferenceTokenAction = typeof tokenActions[number];

export const normalizeEmail = (email: unknown): string | null => {
  if (typeof email !== "string") {
    return null;
  }

  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

export const normalizePhone = (phone: unknown): string | null =>
  typeof phone === "string" ? normalizePhoneNumber(phone) : null;

export const normalizeContact = (channel: CommunicationChannel, value: unknown): string | null =>
  channel === "email" ? normalizeEmail(value) : normalizePhone(value);

export const hashToken = (rawToken: string): string =>
  createHash("sha256").update(rawToken).digest("hex");

export const generatePreferenceToken = (): string => randomBytes(32).toString("base64url");
