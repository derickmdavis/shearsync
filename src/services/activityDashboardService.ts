import { ApiError, requireFound } from "../lib/errors";
import { addDays, getCurrentLocalDate, getEndOfLocalDayUtc, getLocalDateForInstant, getStartOfLocalDayUtc } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { ActivityEventItem } from "../types/api";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { activityEventsService } from "./activityEventsService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { rebookNudgesService } from "./rebookNudgesService";

const AUTOMATION_KEYS = [
  "rebook_nudges",
  "appointment_reminders",
  "email_confirmations",
  "no_show_follow_up",
  "waitlist_match"
] as const;

export type AutomationControlKey = (typeof AUTOMATION_KEYS)[number];

const AUTOMATION_LABELS: Record<AutomationControlKey, string> = {
  rebook_nudges: "Rebook Nudges",
  appointment_reminders: "Appointment Reminders",
  email_confirmations: "Email Confirmations",
  no_show_follow_up: "No Show Follow-up",
  waitlist_match: "Waitlist Match"
};

const APPOINTMENT_SELECT = `
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  status,
  booking_source,
  created_at,
  updated_at
`;

const REMINDER_SELECT = `
  id,
  user_id,
  client_id,
  appointment_id,
  title,
  due_date,
  status,
  channel,
  reminder_type,
  sent_at,
  created_at,
  updated_at
`;

const WAITLIST_SELECT = `
  id,
  user_id,
  client_id,
  service_id,
  requested_date,
  requested_time_preference,
  client_name,
  client_email,
  client_phone,
  note,
  status,
  source,
  created_at,
  updated_at,
  services(name)
`;

const isAutomationControlKey = (value: string): value is AutomationControlKey =>
  (AUTOMATION_KEYS as readonly string[]).includes(value);

const getString = (row: Row, key: string): string | null =>
  typeof row[key] === "string" ? row[key] as string : null;

const getNumber = (row: Row, key: string): number =>
  typeof row[key] === "number" ? row[key] as number : Number(row[key] ?? 0);

const toClientName = (client: Row | undefined): string => {
  const firstName = typeof client?.first_name === "string" ? client.first_name : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name : "";
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Client";
};

const centsFromPrice = (value: unknown): number => Math.round(Number(value ?? 0) * 100);

const loadClientsById = async (userId: string, clientIds: Array<string | null>): Promise<Map<string, Row>> => {
  const ids = [...new Set(clientIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, first_name, last_name")
    .eq("user_id", userId)
    .in("id", ids);

  handleSupabaseError(error, "Unable to load activity dashboard clients");
  return new Map(((data ?? []) as Row[]).map((client) => [client.id as string, client]));
};

const loadAutomationSettings = async (userId: string): Promise<Map<AutomationControlKey, boolean>> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("key, enabled")
    .eq("user_id", userId);

  handleSupabaseError(error, "Unable to load automation settings");

  return new Map(
    ((data ?? []) as Row[])
      .filter((row) => typeof row.key === "string" && isAutomationControlKey(row.key))
      .map((row) => [row.key as AutomationControlKey, row.enabled !== false])
  );
};

const getEnabled = (settings: Map<AutomationControlKey, boolean>, key: AutomationControlKey): boolean =>
  settings.get(key) ?? true;

const loadRecentActivity = async (userId: string): Promise<ActivityEventItem[]> => {
  const feed = await activityEventsService.getFeed(userId, { limit: 10 });
  return feed.groups.flatMap((group) => group.events).slice(0, 10);
};

const loadCancellationReviewItems = async (userId: string, timeZone: string) => {
  const { data, error } = await supabaseAdmin
    .from("activity_events")
    .select("id, client_id, appointment_id, occurred_at, metadata")
    .eq("user_id", userId)
    .eq("activity_type", "appointment_cancelled")
    .order("occurred_at", { ascending: false })
    .limit(50);

  handleSupabaseError(error, "Unable to load cancellation review items");
  const cancellationEvents = (data ?? []) as Row[];
  const appointmentIds = cancellationEvents.map((row) => getString(row, "appointment_id"));
  if (cancellationEvents.length === 0) {
    return [];
  }

  const concreteAppointmentIds = appointmentIds.filter((id): id is string => Boolean(id));
  const appointmentData: Row[] = [];
  if (concreteAppointmentIds.length > 0) {
    const { data: appointments, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .eq("user_id", userId)
      .in("id", concreteAppointmentIds);

    handleSupabaseError(appointmentError, "Unable to load cancellation review appointments");
    appointmentData.push(...((appointments ?? []) as Row[]));
  }

  const appointmentsById = new Map(appointmentData.map((appointment) => [appointment.id as string, appointment]));
  const clientsById = await loadClientsById(userId, cancellationEvents.map((row) => getString(row, "client_id")));

  const clientIds = [...new Set(cancellationEvents.map((row) => getString(row, "client_id")).filter((id): id is string => Boolean(id)))];
  const futureAppointmentData: Row[] = [];
  if (clientIds.length > 0) {
    const { data: futureAppointments, error: futureAppointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, appointment_date, status")
      .eq("user_id", userId)
      .in("client_id", clientIds)
      .neq("status", "cancelled")
      .gte("appointment_date", getStartOfLocalDayUtc(getCurrentLocalDate(timeZone), timeZone).toISOString());

    handleSupabaseError(futureAppointmentError, "Unable to load cancellation resolution appointments");
    futureAppointmentData.push(...((futureAppointments ?? []) as Row[]));
  }

  return cancellationEvents
    .map((event) => {
      const appointmentId = getString(event, "appointment_id");
      if (!appointmentId) {
        return null;
      }

      const appointment = appointmentId ? appointmentsById.get(appointmentId) : undefined;
      if (appointment && appointment.status !== "cancelled") {
        return null;
      }

      const clientId = getString(event, "client_id");
      const metadata = (event.metadata ?? {}) as Row;
      const appointmentStartTime = getString(metadata, "appointment_start_time") ?? getString(appointment ?? {}, "appointment_date");
      const hasReplacement = clientId
        ? futureAppointmentData.some((futureAppointment) => {
          const futureDate = getString(futureAppointment, "appointment_date");
          return futureAppointment.client_id === clientId && (!appointmentStartTime || (futureDate ?? "") >= appointmentStartTime);
        })
        : false;

      if (hasReplacement) {
        return null;
      }

      return {
        appointment_id: appointmentId,
        client_id: clientId,
        client_name: getString(metadata, "client_name") ?? toClientName(clientId ? clientsById.get(clientId) : undefined),
        service_name: getString(metadata, "service_name") ?? getString(appointment ?? {}, "service_name"),
        appointment_start_time: appointmentStartTime,
        canceled_at: getString(event, "occurred_at"),
        canceled_by: getString(metadata, "cancelled_by") ?? "stylist",
        review_status: "pending" as const
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
};

const loadReminderQueue = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("reminders")
    .select(REMINDER_SELECT)
    .eq("user_id", userId)
    .eq("status", "open")
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load reminder queue");
  const reminders = (data ?? []) as Row[];
  const clientsById = await loadClientsById(userId, reminders.map((row) => getString(row, "client_id")));

  return reminders.map((reminder) => {
    const clientId = getString(reminder, "client_id");
    return {
      reminder_id: reminder.id,
      appointment_id: reminder.appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(clientId ? clientsById.get(clientId) : undefined),
      send_at: reminder.due_date,
      channel: reminder.channel ?? "sms",
      reminder_type: reminder.reminder_type ?? "general",
      status: "scheduled"
    };
  });
};

const loadReviewRequestQueue = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("reminders")
    .select(REMINDER_SELECT)
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("reminder_type", "follow_up")
    .order("due_date", { ascending: true })
    .limit(50);

  handleSupabaseError(error, "Unable to load review request queue");
  const reminders = (data ?? []) as Row[];
  const clientsById = await loadClientsById(userId, reminders.map((row) => getString(row, "client_id")));

  return reminders.map((reminder) => {
    const clientId = getString(reminder, "client_id");
    return {
      review_request_id: reminder.id,
      appointment_id: reminder.appointment_id ?? null,
      client_id: clientId,
      client_name: toClientName(clientId ? clientsById.get(clientId) : undefined),
      completed_at: null,
      send_at: reminder.due_date,
      channel: reminder.channel ?? "sms",
      status: "queued"
    };
  });
};

const loadWaitlistMatches = async (userId: string, timeZone: string) => {
  const today = getCurrentLocalDate(timeZone);
  const { data: waitlistData, error: waitlistError } = await supabaseAdmin
    .from("waitlist_entries")
    .select(WAITLIST_SELECT)
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("requested_date", today)
    .order("requested_date", { ascending: true })
    .limit(50);

  handleSupabaseError(waitlistError, "Unable to load waitlist entries for matches");

  const { data: openingData, error: openingError } = await supabaseAdmin
    .from("appointments")
    .select(APPOINTMENT_SELECT)
    .eq("user_id", userId)
    .eq("status", "cancelled")
    .gte("appointment_date", getStartOfLocalDayUtc(today, timeZone).toISOString())
    .order("appointment_date", { ascending: true })
    .limit(50);

  handleSupabaseError(openingError, "Unable to load open appointment slots for waitlist matches");

  const openings = (openingData ?? []) as Row[];
  return ((waitlistData ?? []) as Row[])
    .flatMap((entry) => {
      const service = (entry.services ?? null) as Row | null;
      const entryServiceId = getString(entry, "service_id");
      const entryServiceName = getString(service ?? {}, "name");
      const requestedDate = getString(entry, "requested_date");
      const opening = openings.find((candidate) => {
        const candidateDate = getString(candidate, "appointment_date");
        const sameDate = candidateDate ? getLocalDateForInstant(candidateDate, timeZone) === requestedDate : false;
        const sameService = entryServiceId
          ? candidate.service_id === entryServiceId
          : !entryServiceName || candidate.service_name === entryServiceName;
        return sameDate && sameService;
      });

      if (!opening) {
        return [];
      }

      const openingStart = getString(opening, "appointment_date");
      const durationMinutes = getNumber(opening, "duration_minutes");
      const openingEnd = openingStart
        ? new Date(new Date(openingStart).getTime() + durationMinutes * 60_000).toISOString()
        : null;

      return [{
        waitlist_entry_id: entry.id,
        client_id: entry.client_id ?? null,
        client_name: entry.client_name,
        service_id: entry.service_id ?? null,
        service_name: entryServiceName ?? opening.service_name ?? null,
        requested_date: requestedDate,
        requested_time_preference: entry.requested_time_preference ?? null,
        matched_opening_start_time: openingStart,
        matched_opening_end_time: openingEnd,
        confidence_score: entryServiceId ? 0.9 : 0.75,
        reason: entryServiceId ? "Same service and requested date" : "Requested date has a matching opening"
      }];
    })
    .slice(0, 20);
};

const loadAutomationHealth = async (userId: string, settings: Map<AutomationControlKey, boolean>) => {
  const now = new Date();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60_000).toISOString();

  const [failedEmailsResult, delayedEmailsResult, overdueRemindersResult] = await Promise.all([
    supabaseAdmin
      .from("appointment_email_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "failed"),
    supabaseAdmin
      .from("appointment_email_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "queued")
      .lt("created_at", fifteenMinutesAgo),
    supabaseAdmin
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "open")
      .lt("due_date", now.toISOString())
  ]);

  handleSupabaseError(failedEmailsResult.error, "Unable to load failed automation count");
  handleSupabaseError(delayedEmailsResult.error, "Unable to load delayed automation count");
  handleSupabaseError(overdueRemindersResult.error, "Unable to load overdue reminder count");

  const disabledCount = AUTOMATION_KEYS.filter((key) => !getEnabled(settings, key)).length;
  const failedCount = failedEmailsResult.count ?? 0;
  const delayedCount = (delayedEmailsResult.count ?? 0) + (overdueRemindersResult.count ?? 0);
  const reasons: string[] = [];

  if (failedCount > 0) reasons.push(`${failedCount} automation delivery ${failedCount === 1 ? "failure" : "failures"}`);
  if (delayedCount > 0) reasons.push(`${delayedCount} delayed automation ${delayedCount === 1 ? "item" : "items"}`);
  if (disabledCount > 0) reasons.push(`${disabledCount} automation ${disabledCount === 1 ? "control is" : "controls are"} disabled`);

  const score = Math.max(0, 100 - failedCount * 20 - delayedCount * 5 - disabledCount * 10);
  const status = failedCount > 0 || score < 80 ? "issue" : delayedCount > 0 || disabledCount > 0 ? "warning" : "all_good";

  return {
    score,
    status,
    failed_count: failedCount,
    delayed_count: delayedCount,
    reasons
  };
};

const loadImpactThisWeek = async (userId: string, timeZone: string) => {
  const today = getCurrentLocalDate(timeZone);
  const startDate = addDays(today, -6);
  const startIso = getStartOfLocalDayUtc(startDate, timeZone).toISOString();
  const endIso = getEndOfLocalDayUtc(today, timeZone).toISOString();

  const [bookingActivityResult, reminderActivityResult, filledWaitlistResult] = await Promise.all([
    supabaseAdmin
      .from("activity_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("activity_type", "booking_created")
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso),
    supabaseAdmin
      .from("activity_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("activity_type", "reminder_sent")
      .gte("occurred_at", startIso)
      .lt("occurred_at", endIso),
    supabaseAdmin
      .from("waitlist_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "booked")
      .gte("updated_at", startIso)
      .lt("updated_at", endIso)
  ]);

  handleSupabaseError(bookingActivityResult.error, "Unable to load automation booking impact");
  handleSupabaseError(reminderActivityResult.error, "Unable to load automation reminder impact");
  handleSupabaseError(filledWaitlistResult.error, "Unable to load automation opening impact");

  const openingsFilledCount = filledWaitlistResult.count ?? 0;
  const recoveredRevenueCents = 0;

  return {
    booked_count: 0,
    total_booking_activity_count: bookingActivityResult.count ?? 0,
    recovered_revenue_cents: recoveredRevenueCents,
    reminders_sent_count: reminderActivityResult.count ?? 0,
    openings_filled_count: openingsFilledCount
  };
};

export const activityDashboardService = {
  isAutomationControlKey,

  async getDashboard(userId: string): Promise<Row> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const [
      settings,
      recentActivity,
      cancellationReviewItems,
      reminderQueue,
      reviewRequestQueue,
      waitlistMatches,
      feedCounts,
      rebookNudgeCounts,
      outstandingRebookNudges
    ] = await Promise.all([
      loadAutomationSettings(userId),
      loadRecentActivity(userId),
      loadCancellationReviewItems(userId, timeZone),
      loadReminderQueue(userId),
      loadReviewRequestQueue(userId),
      loadWaitlistMatches(userId, timeZone),
      activityEventsService.getCategoryCounts(userId, {}, timeZone),
      rebookNudgesService.getCountsForUser(userId),
      rebookNudgesService.getOutstandingForUser(userId, 50)
    ]);

    const [automationHealth, automationImpactThisWeek] = await Promise.all([
      loadAutomationHealth(userId, settings),
      loadImpactThisWeek(userId, timeZone)
    ]);

    const noShowTodayCount = 0;
    const automationControls = [
      {
        key: "rebook_nudges",
        label: AUTOMATION_LABELS.rebook_nudges,
        enabled: getEnabled(settings, "rebook_nudges"),
        status_label: rebookNudgeCounts.pending_approval > 0
          ? `${rebookNudgeCounts.pending_approval} need approval`
          : `${rebookNudgeCounts.queued} queued`,
        due_count: feedCounts.rebook,
        pending_approval_count: rebookNudgeCounts.pending_approval,
        queued_count: rebookNudgeCounts.queued
      },
      {
        key: "appointment_reminders",
        label: AUTOMATION_LABELS.appointment_reminders,
        enabled: getEnabled(settings, "appointment_reminders"),
        status_label: `${reminderQueue.length} scheduled`,
        scheduled_count: reminderQueue.length
      },
      {
        key: "email_confirmations",
        label: AUTOMATION_LABELS.email_confirmations,
        enabled: getEnabled(settings, "email_confirmations"),
        status_label: getEnabled(settings, "email_confirmations") ? "On for bookings" : "Paused"
      },
      {
        key: "no_show_follow_up",
        label: AUTOMATION_LABELS.no_show_follow_up,
        enabled: getEnabled(settings, "no_show_follow_up"),
        status_label: `${noShowTodayCount} needed today`,
        due_count: noShowTodayCount
      },
      {
        key: "waitlist_match",
        label: AUTOMATION_LABELS.waitlist_match,
        enabled: getEnabled(settings, "waitlist_match"),
        status_label: `${waitlistMatches.length} ${waitlistMatches.length === 1 ? "match" : "matches"} found`,
        match_count: waitlistMatches.length
      }
    ];

    return {
      needs_attention: {
        cancellations_need_review_count: cancellationReviewItems.length,
        waitlist_match_count: waitlistMatches.length,
        pending_reminder_count: reminderQueue.length,
        queued_review_request_count: reviewRequestQueue.length,
        pending_rebook_nudge_count: rebookNudgeCounts.pending_approval
      },
      pending_rebook_nudge_count: rebookNudgeCounts.pending_approval,
      queued_rebook_nudge_count: rebookNudgeCounts.queued,
      outstanding_rebook_nudges: outstandingRebookNudges,
      cancellation_review_count: cancellationReviewItems.length,
      cancellation_review_items: cancellationReviewItems,
      waitlist_match_count: waitlistMatches.length,
      waitlist_matches: waitlistMatches,
      pending_reminder_count: reminderQueue.length,
      scheduled_reminder_count: reminderQueue.length,
      reminder_queue: reminderQueue,
      queued_review_request_count: reviewRequestQueue.length,
      review_request_queue: reviewRequestQueue,
      automation_health: automationHealth,
      automation_health_score: automationHealth.score,
      automation_health_status: automationHealth.status,
      failed_automation_count: automationHealth.failed_count,
      delayed_automation_count: automationHealth.delayed_count,
      health_reasons: automationHealth.reasons,
      automation_impact_this_week: automationImpactThisWeek,
      recent_activity: recentActivity,
      automation_controls: automationControls
    };
  },

  async updateAutomationSetting(userId: string, key: string, enabled: boolean): Promise<Row> {
    if (!isAutomationControlKey(key)) {
      throw new ApiError(400, "Unsupported automation setting key");
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("automation_settings")
      .select("*")
      .eq("user_id", userId)
      .eq("key", key)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to load automation setting");

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("automation_settings")
        .update({ enabled })
        .eq("user_id", userId)
        .eq("key", key)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update automation setting");
      return requireFound(data, "Automation setting not found");
    }

    const { data, error } = await supabaseAdmin
      .from("automation_settings")
      .insert({ user_id: userId, key, enabled })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create automation setting");
    return requireFound(data, "Automation setting was not created");
  }
};
