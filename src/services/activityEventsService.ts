import { ApiError, requireFound } from "../lib/errors";
import {
  addDays,
  formatDateInTimeZone,
  getCurrentLocalDate,
  getEndOfLocalDayUtc,
  getLocalDateForInstant,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type {
  ActivityDayGroup,
  ActivityEventMetadata,
  ActivityEventItem,
  ActivityFeedResponse,
  ActivityGroupSummary,
  ActivityType,
  AppointmentCancelledActivityMetadata,
  AppointmentRescheduledActivityMetadata,
  BookingCreatedActivityMetadata,
  ReminderChannel,
  ReminderSentActivityMetadata,
  ReminderType
} from "../types/api";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

interface ActivityFeedFilters {
  limit: number;
  cursor?: string;
  activity_type?: ActivityType;
  start_date?: string;
  end_date?: string;
}

interface CursorPayload {
  occurred_at: string;
  id: string;
}

interface ClientNameParts {
  fullName: string;
  shortName: string;
}

const ACTIVITY_EVENT_SELECT =
  "id, activity_type, title, description, occurred_at, client_id, appointment_id, metadata";

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeActivityMetadata = (
  activityType: ActivityType,
  value: unknown
): ActivityEventMetadata | null => {
  if (!isRecord(value)) {
    return null;
  }

  switch (activityType) {
    case "booking_created":
      if (
        typeof value.client_name === "string"
        && typeof value.service_name === "string"
        && typeof value.appointment_start_time === "string"
      ) {
        return {
          client_name: value.client_name,
          service_name: value.service_name,
          appointment_start_time: value.appointment_start_time
        };
      }
      return null;
    case "appointment_cancelled":
      if (
        typeof value.client_name === "string"
        && typeof value.service_name === "string"
        && typeof value.appointment_start_time === "string"
        && (value.cancelled_by === "client" || value.cancelled_by === "stylist")
      ) {
        return {
          client_name: value.client_name,
          service_name: value.service_name,
          appointment_start_time: value.appointment_start_time,
          cancelled_by: value.cancelled_by
        };
      }
      return null;
    case "appointment_rescheduled":
      if (
        typeof value.client_name === "string"
        && typeof value.service_name === "string"
        && typeof value.old_start_time === "string"
        && typeof value.new_start_time === "string"
      ) {
        return {
          client_name: value.client_name,
          service_name: value.service_name,
          old_start_time: value.old_start_time,
          new_start_time: value.new_start_time
        };
      }
      return null;
    case "reminder_sent":
      if (
        typeof value.client_name === "string"
        && (value.channel === "sms" || value.channel === "email")
        && (
          value.reminder_type === "appointment_reminder"
          || value.reminder_type === "follow_up"
          || value.reminder_type === "general"
        )
        && (typeof value.appointment_start_time === "string" || value.appointment_start_time === null)
      ) {
        return {
          client_name: value.client_name,
          channel: value.channel,
          reminder_type: value.reminder_type,
          appointment_start_time: value.appointment_start_time
        };
      }
      return null;
  }
};

const toRowActivityItem = (row: Row): ActivityEventItem => {
  const activityType = row.activity_type as ActivityType;

  return {
    id: String(row.id ?? ""),
    activity_type: activityType,
  title: String(row.title ?? ""),
  description: typeof row.description === "string" ? row.description : null,
  occurred_at: String(row.occurred_at ?? ""),
  client_id: typeof row.client_id === "string" ? row.client_id : null,
  appointment_id: typeof row.appointment_id === "string" ? row.appointment_id : null,
    metadata: normalizeActivityMetadata(activityType, row.metadata)
  };
};

const toSummaryKey = (activityType: ActivityType): keyof ActivityGroupSummary => {
  switch (activityType) {
    case "booking_created":
      return "new_bookings";
    case "appointment_cancelled":
      return "cancellations";
    case "appointment_rescheduled":
      return "reschedules";
    case "reminder_sent":
      return "reminders_sent";
  }
};

const createEmptySummary = (): ActivityGroupSummary => ({
  new_bookings: 0,
  cancellations: 0,
  reschedules: 0,
  reminders_sent: 0
});

const createClientNameParts = (client: Row | null): ClientNameParts => {
  const preferredName = typeof client?.preferred_name === "string" ? client.preferred_name.trim() : "";
  const firstName = typeof client?.first_name === "string" ? client.first_name.trim() : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || preferredName || firstName || "Client";
  return {
    fullName,
    shortName: preferredName || firstName || fullName
  };
};

const formatLocalTime = (instant: string, timeZone: string): string =>
  formatDateInTimeZone(new Date(instant), timeZone, {
    hour: "numeric",
    minute: "2-digit"
  });

const formatLocalDayAndTime = (instant: string, timeZone: string): string =>
  formatDateInTimeZone(new Date(instant), timeZone, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });

const getDayLabel = (dateText: string, timeZone: string, now = new Date()): string => {
  const currentLocalDate = getCurrentLocalDate(timeZone, now);
  if (dateText === currentLocalDate) {
    return "Today";
  }

  if (dateText === addDays(currentLocalDate, -1)) {
    return "Yesterday";
  }

  return formatDateInTimeZone(zonedDateTimeToUtc(dateText, timeZone, 12, 0, 0, 0), timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
};

const compareRowsDescending = (left: Row, right: Row): number => {
  const leftOccurredAt = String(left.occurred_at ?? "");
  const rightOccurredAt = String(right.occurred_at ?? "");

  if (leftOccurredAt !== rightOccurredAt) {
    return rightOccurredAt.localeCompare(leftOccurredAt);
  }

  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
};

const encodeCursor = (event: ActivityEventItem): string =>
  Buffer.from(JSON.stringify({ occurred_at: event.occurred_at, id: event.id } satisfies CursorPayload), "utf8").toString("base64url");

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.occurred_at !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor shape");
    }

    return parsed;
  } catch {
    throw new ApiError(400, "Invalid activity cursor");
  }
};

const isBeforeCursor = (row: Row, cursor: CursorPayload): boolean => {
  const occurredAt = String(row.occurred_at ?? "");
  if (occurredAt !== cursor.occurred_at) {
    return occurredAt < cursor.occurred_at;
  }

  return String(row.id ?? "") < cursor.id;
};

const groupEventsByDay = (events: ActivityEventItem[], timeZone: string): ActivityDayGroup[] => {
  const groups = new Map<string, ActivityDayGroup>();

  for (const event of events) {
    const dateText = getLocalDateForInstant(event.occurred_at, timeZone);
    const existing = groups.get(dateText) ?? {
      date: dateText,
      label: getDayLabel(dateText, timeZone),
      summary: createEmptySummary(),
      events: []
    };

    existing.events.push(event);
    existing.summary[toSummaryKey(event.activity_type)] += 1;
    groups.set(dateText, existing);
  }

  return [...groups.values()].sort((left, right) => right.date.localeCompare(left.date));
};

const getReminderChannel = (value: unknown): ReminderChannel =>
  value === "email" ? "email" : "sms";

const getReminderType = (value: unknown, appointmentId: string | null): ReminderType => {
  if (value === "appointment_reminder" || value === "follow_up" || value === "general") {
    return value;
  }

  return appointmentId ? "appointment_reminder" : "general";
};

const getActivityEventDedupeKey = (activityType: ActivityType, uniqueParts: string[]): string =>
  [activityType, ...uniqueParts].join(":");

const createBookingCreatedMetadata = (
  clientNames: ClientNameParts,
  serviceName: string,
  appointmentStartTime: string
): BookingCreatedActivityMetadata => ({
  client_name: clientNames.fullName,
  service_name: serviceName,
  appointment_start_time: appointmentStartTime
});

const createAppointmentCancelledMetadata = (
  clientNames: ClientNameParts,
  serviceName: string,
  appointmentStartTime: string,
  cancelledBy: AppointmentCancelledActivityMetadata["cancelled_by"]
): AppointmentCancelledActivityMetadata => ({
  client_name: clientNames.fullName,
  service_name: serviceName,
  appointment_start_time: appointmentStartTime,
  cancelled_by: cancelledBy
});

const createAppointmentRescheduledMetadata = (
  clientNames: ClientNameParts,
  serviceName: string,
  oldStartTime: string,
  newStartTime: string
): AppointmentRescheduledActivityMetadata => ({
  client_name: clientNames.fullName,
  service_name: serviceName,
  old_start_time: oldStartTime,
  new_start_time: newStartTime
});

const createReminderSentMetadata = (
  clientNames: ClientNameParts,
  channel: ReminderChannel,
  reminderType: ReminderType,
  appointmentStartTime: string | null
): ReminderSentActivityMetadata => ({
  client_name: clientNames.fullName,
  channel,
  reminder_type: reminderType,
  appointment_start_time: appointmentStartTime
});

export const activityEventsService = {
  async getFeed(stylistId: string, filters: ActivityFeedFilters): Promise<ActivityFeedResponse> {
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    let query = supabaseAdmin
      .from("activity_events")
      .select(ACTIVITY_EVENT_SELECT)
      .eq("stylist_id", stylistId);

    if (filters.activity_type) {
      query = query.eq("activity_type", filters.activity_type);
    }

    if (filters.start_date) {
      query = query.gte("occurred_at", getStartOfLocalDayUtc(filters.start_date, timeZone).toISOString());
    }

    if (filters.end_date) {
      query = query.lt("occurred_at", getEndOfLocalDayUtc(filters.end_date, timeZone).toISOString());
    }

    const { data, error } = await query
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });

    handleSupabaseError(error, "Unable to load activity feed");

    const sortedRows = ((data ?? []) as Row[]).sort(compareRowsDescending);
    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    const filteredRows = cursor ? sortedRows.filter((row) => isBeforeCursor(row, cursor)) : sortedRows;
    const pageRows = filteredRows.slice(0, filters.limit);
    const events = pageRows.map((row) => toRowActivityItem(row));
    const nextCursor = filteredRows.length > filters.limit && events.length > 0
      ? encodeCursor(events[events.length - 1] as ActivityEventItem)
      : null;

    return {
      groups: groupEventsByDay(events, timeZone),
      next_cursor: nextCursor
    };
  },

  async listByAppointment(stylistId: string, appointmentId: string): Promise<ActivityEventItem[]> {
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("id", appointmentId)
      .eq("user_id", stylistId)
      .maybeSingle();

    handleSupabaseError(appointmentError, "Unable to load appointment activity");
    requireFound(appointment, "Appointment not found");

    const { data, error } = await supabaseAdmin
      .from("activity_events")
      .select(ACTIVITY_EVENT_SELECT)
      .eq("stylist_id", stylistId)
      .eq("appointment_id", appointmentId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });

    handleSupabaseError(error, "Unable to load appointment activity");
    return ((data ?? []) as Row[]).sort(compareRowsDescending).map((row) => toRowActivityItem(row));
  },

  async recordBookingCreated(stylistId: string, appointment: Row): Promise<void> {
    const client = await this.getClient(stylistId, appointment.client_id as string);
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    const clientNames = createClientNameParts(client);
    const appointmentDate = String(appointment.appointment_date ?? "");
    const serviceName = String(appointment.service_name ?? "Appointment");

    await this.createIfMissing({
      stylistId,
      clientId: appointment.client_id as string,
      appointmentId: appointment.id as string,
      activityType: "booking_created",
      title: `${clientNames.shortName} booked ${serviceName}`,
      description: `Appointment scheduled for ${formatLocalTime(appointmentDate, timeZone)}`,
      occurredAt: String(appointment.created_at ?? new Date().toISOString()),
      metadata: createBookingCreatedMetadata(clientNames, serviceName, appointmentDate),
      dedupeKey: getActivityEventDedupeKey("booking_created", [String(appointment.id ?? "")])
    });
  },

  async recordAppointmentCancelled(stylistId: string, before: Row, after: Row): Promise<void> {
    const client = await this.getClient(stylistId, before.client_id as string);
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    const clientNames = createClientNameParts(client);
    const appointmentDate = String(before.appointment_date ?? after.appointment_date ?? "");
    const serviceName = String(after.service_name ?? before.service_name ?? "Appointment");

    await this.createIfMissing({
      stylistId,
      clientId: before.client_id as string,
      appointmentId: before.id as string,
      activityType: "appointment_cancelled",
      title: `${clientNames.shortName} cancelled ${serviceName}`,
      description: `Appointment was scheduled for ${formatLocalDayAndTime(appointmentDate, timeZone)}`,
      occurredAt: String(after.updated_at ?? new Date().toISOString()),
      metadata: createAppointmentCancelledMetadata(clientNames, serviceName, appointmentDate, "stylist"),
      dedupeKey: getActivityEventDedupeKey("appointment_cancelled", [String(before.id ?? ""), appointmentDate])
    });
  },

  async recordAppointmentRescheduled(stylistId: string, before: Row, after: Row): Promise<void> {
    const client = await this.getClient(stylistId, before.client_id as string);
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    const clientNames = createClientNameParts(client);
    const oldStartTime = String(before.appointment_date ?? "");
    const newStartTime = String(after.appointment_date ?? "");
    const serviceName = String(after.service_name ?? before.service_name ?? "Appointment");
    const description = oldStartTime !== newStartTime
      ? `Moved from ${formatLocalDayAndTime(oldStartTime, timeZone)} to ${formatLocalDayAndTime(newStartTime, timeZone)}`
      : `Appointment timing updated for ${formatLocalDayAndTime(newStartTime, timeZone)}`;

    await this.createIfMissing({
      stylistId,
      clientId: before.client_id as string,
      appointmentId: before.id as string,
      activityType: "appointment_rescheduled",
      title: `${clientNames.shortName} rescheduled ${serviceName}`,
      description,
      occurredAt: String(after.updated_at ?? new Date().toISOString()),
      metadata: createAppointmentRescheduledMetadata(clientNames, serviceName, oldStartTime, newStartTime),
      dedupeKey: getActivityEventDedupeKey("appointment_rescheduled", [
        String(before.id ?? ""),
        oldStartTime,
        String(before.duration_minutes ?? ""),
        newStartTime,
        String(after.duration_minutes ?? "")
      ])
    });
  },

  async recordReminderSent(stylistId: string, reminder: Row): Promise<void> {
    const client = await this.getClient(stylistId, reminder.client_id as string);
    const appointmentId = typeof reminder.appointment_id === "string" ? reminder.appointment_id : null;
    const appointment = appointmentId ? await this.getAppointment(stylistId, appointmentId) : null;
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    const clientNames = createClientNameParts(client);
    const channel = getReminderChannel(reminder.channel);
    const reminderType = getReminderType(reminder.reminder_type, appointmentId);
    const occurredAt = String(reminder.sent_at ?? reminder.updated_at ?? new Date().toISOString());
    const appointmentStartTime = typeof appointment?.appointment_date === "string" ? appointment.appointment_date : null;
    const appointmentDateText = appointmentStartTime ? getLocalDateForInstant(appointmentStartTime, timeZone) : null;
    const currentLocalDate = getCurrentLocalDate(timeZone, new Date(occurredAt));
    const description = appointmentStartTime
      ? appointmentDateText === currentLocalDate
        ? `Reminder for today's ${formatLocalTime(appointmentStartTime, timeZone)} appointment`
        : `Reminder for ${formatLocalDayAndTime(appointmentStartTime, timeZone)} appointment`
      : `Reminder sent by ${channel.toUpperCase()}`;

    await this.createIfMissing({
      stylistId,
      clientId: reminder.client_id as string,
      appointmentId,
      activityType: "reminder_sent",
      title: `${channel.toUpperCase()} reminder sent to ${clientNames.shortName}`,
      description,
      occurredAt,
      metadata: createReminderSentMetadata(clientNames, channel, reminderType, appointmentStartTime),
      dedupeKey: getActivityEventDedupeKey("reminder_sent", [
        String(reminder.id ?? ""),
        channel,
        occurredAt
      ])
    });
  },

  async createIfMissing(input: {
    stylistId: string;
    clientId: string | null;
    appointmentId: string | null;
    activityType: ActivityType;
    title: string;
    description: string | null;
    occurredAt: string;
    metadata: ActivityEventMetadata;
    dedupeKey: string;
  }): Promise<void> {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("activity_events")
      .select("id")
      .eq("stylist_id", input.stylistId)
      .eq("dedupe_key", input.dedupeKey)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to validate activity event uniqueness");
    if (existing) {
      return;
    }

    const { error } = await supabaseAdmin
      .from("activity_events")
      .insert({
        stylist_id: input.stylistId,
        client_id: input.clientId,
        appointment_id: input.appointmentId,
        activity_type: input.activityType,
        title: input.title,
        description: input.description,
        occurred_at: input.occurredAt,
        metadata: input.metadata,
        dedupe_key: input.dedupeKey
      });

    if (isUniqueViolation(error)) {
      return;
    }

    handleSupabaseError(error, "Unable to create activity event");
  },

  async getClient(stylistId: string, clientId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name")
      .eq("id", clientId)
      .eq("user_id", stylistId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load activity client");
    return data;
  },

  async getAppointment(stylistId: string, appointmentId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("id, appointment_date, duration_minutes, service_name")
      .eq("id", appointmentId)
      .eq("user_id", stylistId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load activity appointment");
    return data;
  }
};
