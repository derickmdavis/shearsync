import { calculatePercentChange } from "../lib/appointmentMetrics";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InsightsAppointmentChanges = {
  window: {
    label: "Last 24 hours";
    currentStartAt: string;
    currentEndAt: string;
    previousStartAt: string;
    previousEndAt: string;
  };
  newAppointments: { currentCount: number; previousCount: number; percentChange: number | null };
  cancellations: { currentCount: number; previousCount: number; percentChange: number | null };
};

const countEvents = async (input: {
  userId: string;
  activityType: "booking_created" | "appointment_cancelled";
  startAt: string;
  endAt: string;
}): Promise<number> => {
  // activity_events has a database-enforced unique (user_id, dedupe_key)
  // constraint. Counting canonical events therefore cannot double-count a
  // repeated mutation and has no feed-pagination limit.
  const { count, error } = await supabaseAdmin
    .from("activity_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .eq("activity_type", input.activityType)
    .gte("occurred_at", input.startAt)
    .lt("occurred_at", input.endAt);
  handleSupabaseError(error, "Unable to load Insights appointment changes");
  return count ?? 0;
};

export const insightsAppointmentChangesService = {
  async getForUser(userId: string, now = new Date()): Promise<InsightsAppointmentChanges> {
    const currentEndAt = now.toISOString();
    const currentStartAt = new Date(now.getTime() - DAY_MS).toISOString();
    const previousStartAt = new Date(now.getTime() - (2 * DAY_MS)).toISOString();
    const previousEndAt = currentStartAt;

    const [currentBookings, previousBookings, currentCancellations, previousCancellations] = await Promise.all([
      countEvents({ userId, activityType: "booking_created", startAt: currentStartAt, endAt: currentEndAt }),
      countEvents({ userId, activityType: "booking_created", startAt: previousStartAt, endAt: previousEndAt }),
      countEvents({ userId, activityType: "appointment_cancelled", startAt: currentStartAt, endAt: currentEndAt }),
      countEvents({ userId, activityType: "appointment_cancelled", startAt: previousStartAt, endAt: previousEndAt })
    ]);

    return {
      window: { label: "Last 24 hours", currentStartAt, currentEndAt, previousStartAt, previousEndAt },
      newAppointments: {
        currentCount: currentBookings,
        previousCount: previousBookings,
        percentChange: calculatePercentChange(currentBookings, previousBookings)
      },
      cancellations: {
        currentCount: currentCancellations,
        previousCount: previousCancellations,
        percentChange: calculatePercentChange(currentCancellations, previousCancellations)
      }
    };
  }
};
