import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { appointmentEmailEventsService } from "./appointmentEmailEventsService";
import { appointmentReminderSuppressionsService } from "./appointmentReminderSuppressionsService";

const reminderOffsetMs = 24 * 60 * 60 * 1000;
const defaultWindowMinutes = 15;
const defaultUserLimit = 100;
const defaultAppointmentLimit = 100;
const reminderStatuses = ["pending", "scheduled"] as const;

interface QueueDueOptions {
  userLimit?: number;
  appointmentLimit?: number;
  windowMinutes?: number;
}

const isAppointmentRemindersEnabled = async (userId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("enabled")
    .eq("user_id", userId)
    .eq("key", "appointment_reminders")
    .maybeSingle();

  handleSupabaseError(error, "Unable to load appointment reminder automation setting");
  return data?.enabled === true;
};

const getDueWindow = (now: Date, windowMinutes: number): { start: string; end: string } => {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const target = now.getTime() + reminderOffsetMs;

  return {
    start: new Date(target - windowMs).toISOString(),
    end: new Date(target + windowMs).toISOString()
  };
};

const loadDueAppointmentsForUser = async (
  userId: string,
  now: Date,
  windowMinutes: number,
  limit: number
): Promise<Row[]> => {
  const { start, end } = getDueWindow(now, windowMinutes);
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("*")
    .eq("user_id", userId)
    .in("status", [...reminderStatuses])
    .gte("appointment_date", start)
    .lte("appointment_date", end)
    .order("appointment_date", { ascending: true })
    .limit(limit);

  handleSupabaseError(error, "Unable to load due appointment reminders");
  return (data ?? []) as Row[];
};

const loadDueAppointments = async (
  now: Date,
  windowMinutes: number,
  limit: number
): Promise<Row[]> => {
  const { start, end } = getDueWindow(now, windowMinutes);
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("*")
    .in("status", [...reminderStatuses])
    .gte("appointment_date", start)
    .lte("appointment_date", end)
    .order("appointment_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);

  handleSupabaseError(error, "Unable to load due appointment reminders");
  return (data ?? []) as Row[];
};

const loadEnabledAppointmentReminderUserIds = async (userIds: string[]): Promise<Set<string>> => {
  if (userIds.length === 0) {
    return new Set();
  }

  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("user_id")
    .eq("key", "appointment_reminders")
    .eq("enabled", true)
    .in("user_id", userIds);

  handleSupabaseError(error, "Unable to load enabled appointment reminder automation settings");
  return new Set(
    ((data ?? []) as Row[])
      .map((setting) => String(setting.user_id ?? ""))
      .filter(Boolean)
  );
};

const hasReminderEmailEvent = async (appointment: Row): Promise<boolean> => {
  const appointmentId = String(appointment.id ?? "");
  const appointmentStartTime = String(appointment.appointment_date ?? "");
  const idempotencyKey = appointmentEmailEventsService.getIdempotencyKey(
    "appointment_reminder",
    appointmentId,
    appointmentStartTime
  );
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  handleSupabaseError(error, "Unable to validate appointment reminder uniqueness");
  return Boolean(data);
};

const queueAppointmentReminder = async (userId: string, appointment: Row): Promise<"queued" | "skipped"> => {
  const appointmentId = String(appointment.id ?? "");
  const appointmentStartAt = String(appointment.appointment_date ?? "");
  if (
    !appointmentId
    || !appointmentStartAt
    || await appointmentReminderSuppressionsService.isSuppressed(userId, appointmentId, appointmentStartAt)
  ) {
    return "skipped";
  }

  if (await hasReminderEmailEvent(appointment)) {
    return "skipped";
  }

  const emailEvent = await appointmentEmailEventsService.queueAppointmentEmail(
    userId,
    appointment,
    "appointment_reminder"
  );

  return emailEvent ? "queued" : "skipped";
};

export const appointmentRemindersService = {
  async queueDueForUser(
    userId: string,
    now = new Date(),
    appointmentLimit = defaultAppointmentLimit,
    windowMinutes = defaultWindowMinutes
  ): Promise<{ queued: number; skipped: number }> {
    if (!(await isAppointmentRemindersEnabled(userId))) {
      return { queued: 0, skipped: 0 };
    }

    const appointments = await loadDueAppointmentsForUser(userId, now, windowMinutes, appointmentLimit);
    let queued = 0;
    let skipped = 0;

    for (const appointment of appointments) {
      const result = await queueAppointmentReminder(userId, appointment);
      if (result === "queued") {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    return { queued, skipped };
  },

  async queueDue(
    now = new Date(),
    options: QueueDueOptions = {}
  ): Promise<{ processed_users: number; queued: number; skipped: number }> {
    const userLimit = options.userLimit ?? defaultUserLimit;
    const appointmentLimit = options.appointmentLimit ?? defaultAppointmentLimit;
    const windowMinutes = options.windowMinutes ?? defaultWindowMinutes;
    const appointments = await loadDueAppointments(now, windowMinutes, appointmentLimit);
    const userIds = [
      ...new Set(
        appointments
          .map((appointment) => String(appointment.user_id ?? ""))
          .filter(Boolean)
      )
    ];
    const enabledUserIds = await loadEnabledAppointmentReminderUserIds(userIds);

    let queued = 0;
    let skipped = 0;
    const processedUserIds = new Set<string>();

    for (const appointment of appointments) {
      const userId = String(appointment.user_id ?? "");
      if (!userId || !enabledUserIds.has(userId)) {
        continue;
      }

      if (!processedUserIds.has(userId) && processedUserIds.size >= userLimit) {
        continue;
      }

      processedUserIds.add(userId);
      const result = await queueAppointmentReminder(userId, appointment);
      if (result === "queued") {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      processed_users: processedUserIds.size,
      queued,
      skipped
    };
  }
};
