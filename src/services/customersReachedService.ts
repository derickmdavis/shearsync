import type { MessageType } from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

export const CUSTOMERS_REACHED_WINDOW_DAYS = 30;

export const CUSTOMER_REACHED_MESSAGE_TYPES: MessageType[] = [
  "appointment_reminder",
  "appointment_cancelled",
  "appointment_rescheduled",
  "waitlist_update",
  "rebooking_prompt",
  "birthday_reminder",
  "marketing"
];

const appointmentEmailTypes = [
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder",
  "rebooking_prompt",
  "birthday_reminder",
  "thank_you_email"
];

const reminderTypes = ["appointment_reminder", "follow_up", "general"];

const collectClientIds = (target: Set<string>, rows: Row[] | null | undefined): void => {
  for (const row of rows ?? []) {
    if (typeof row.client_id === "string") target.add(row.client_id);
  }
};

export const customersReachedService = {
  async getForUser(userId: string, timezone: string, now = new Date()) {
    const windowEnd = now.toISOString();
    const windowStart = new Date(now.getTime() - CUSTOMERS_REACHED_WINDOW_DAYS * 86_400_000).toISOString();
    const results = await Promise.all([
      supabaseAdmin.from("communication_events").select("client_id").eq("user_id", userId)
        .in("status", ["sent", "delivered"]).in("message_type", CUSTOMER_REACHED_MESSAGE_TYPES)
        .not("client_id", "is", null).gte("created_at", windowStart).lte("created_at", windowEnd),
      supabaseAdmin.from("appointment_email_events").select("client_id").eq("user_id", userId)
        .eq("status", "sent").in("email_type", appointmentEmailTypes)
        .not("client_id", "is", null).gte("sent_at", windowStart).lte("sent_at", windowEnd),
      supabaseAdmin.from("reminders").select("client_id").eq("user_id", userId)
        .eq("status", "sent").in("reminder_type", reminderTypes)
        .not("client_id", "is", null).gte("sent_at", windowStart).lte("sent_at", windowEnd),
      supabaseAdmin.from("activity_events").select("client_id").eq("user_id", userId)
        .eq("activity_type", "reminder_sent").not("client_id", "is", null)
        .gte("occurred_at", windowStart).lte("occurred_at", windowEnd),
      supabaseAdmin.from("rebook_nudges").select("client_id").eq("user_id", userId)
        .eq("status", "sent").not("client_id", "is", null).gte("sent_at", windowStart).lte("sent_at", windowEnd),
      supabaseAdmin.from("birthday_reminders").select("client_id").eq("user_id", userId)
        .eq("status", "sent").not("client_id", "is", null).gte("sent_at", windowStart).lte("sent_at", windowEnd),
      supabaseAdmin.from("thank_you_emails").select("client_id").eq("user_id", userId)
        .eq("status", "sent").not("client_id", "is", null).gte("sent_at", windowStart).lte("sent_at", windowEnd)
    ]);

    const errors = [
      "communication events", "appointment emails", "reminders", "reminder activity",
      "rebook nudges", "birthday reminders", "thank-you emails"
    ];
    results.forEach((result, index) => handleSupabaseError(result.error, `Unable to load customers reached ${errors[index]}`));

    const clientIds = new Set<string>();
    results.forEach((result) => collectClientIds(clientIds, result.data as Row[] | null | undefined));

    return {
      unique_clients: clientIds.size,
      window_start: windowStart,
      window_end: windowEnd,
      timezone,
      window_kind: "rolling" as const,
      window_days: CUSTOMERS_REACHED_WINDOW_DAYS,
      included_message_types: [...CUSTOMER_REACHED_MESSAGE_TYPES, "thank_you_email"]
    };
  }
};
