export const ACTIVITY_TYPES = [
  "booking_created",
  "appointment_cancelled",
  "appointment_rescheduled",
  "reminder_sent"
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const isActivityType = (value: string): value is ActivityType =>
  (ACTIVITY_TYPES as readonly string[]).includes(value);
