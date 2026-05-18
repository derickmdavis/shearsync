export const ACTIVITY_TYPES = [
  "booking_created",
  "appointment_cancelled",
  "appointment_rescheduled",
  "reminder_sent",
  "waitlist_joined"
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const isActivityType = (value: string): value is ActivityType =>
  (ACTIVITY_TYPES as readonly string[]).includes(value);

export const ACTIVITY_CATEGORIES = ["updates", "approvals", "waitlist"] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
