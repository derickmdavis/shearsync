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
import type { ActivityCategory } from "../lib/activityTypes";
import type {
  ActivityDayGroup,
  ActivityEventMetadata,
  ActivityEventItem,
  ActivityFeedCounts,
  ActivityFeedResponse,
  ActivityGroupSummary,
  ActivityType,
  AppointmentCancelledActivityMetadata,
  AppointmentRescheduledActivityMetadata,
  AppointmentStatus,
  BookingCreatedActivityMetadata,
  ClientRebookNeededActivityMetadata,
  ReminderChannel,
  ReminderSentActivityMetadata,
  ReminderType,
  WaitlistJoinedActivityMetadata
} from "../types/api";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { evaluateClientRebookStatus } from "./rebookService";

interface ActivityFeedFilters {
  limit: number;
  cursor?: string;
  category?: ActivityCategory;
  activity_type?: ActivityType;
  start_date?: string;
  end_date?: string;
}

type PersistedActivityType = Exclude<ActivityType, "client_rebook_needed">;

interface CursorPayload {
  occurred_at: string;
  id: string;
  category?: ActivityCategory;
}

interface ClientNameParts {
  fullName: string;
  shortName: string;
}

const ACTIVITY_EVENT_SELECT =
  "id, activity_type, title, description, occurred_at, client_id, appointment_id, metadata";

const PENDING_APPROVAL_SELECT =
  "id, client_id, appointment_date, service_name, status, created_at";

const REBOOK_CLIENT_SELECT =
  "id, first_name, last_name, preferred_name";

const REBOOK_APPOINTMENT_SELECT =
  "id, client_id, appointment_date, service_name, status";

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isAppointmentStatus = (value: unknown): value is AppointmentStatus =>
  value === "pending"
  || value === "scheduled"
  || value === "completed"
  || value === "cancelled"
  || value === "no_show";

const normalizeActivityMetadata = (
  activityType: ActivityType,
  value: unknown,
  currentAppointmentStatus?: AppointmentStatus
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
          appointment_start_time: value.appointment_start_time,
          ...(currentAppointmentStatus ? { current_appointment_status: currentAppointmentStatus } : {})
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
    case "waitlist_joined":
      if (
        typeof value.client_name === "string"
        && (typeof value.service_name === "string" || value.service_name === null)
        && typeof value.requested_date === "string"
        && (typeof value.requested_time_preference === "string" || value.requested_time_preference === null)
        && (
          value.source === "public_booking"
          || value.source === "stylist_created"
          || value.source === "manual"
        )
      ) {
        return {
          client_name: value.client_name,
          service_name: value.service_name,
          requested_date: value.requested_date,
          requested_time_preference: value.requested_time_preference,
          source: value.source
        };
      }
      return null;
    case "client_rebook_needed":
      if (
        typeof value.client_name === "string"
        && typeof value.last_appointment_date === "string"
        && (typeof value.last_service_name === "string" || value.last_service_name === null)
      ) {
        return {
          client_name: value.client_name,
          last_appointment_date: value.last_appointment_date,
          last_service_name: value.last_service_name
        };
      }
      return null;
  }
};

const toRowActivityItem = (row: Row, appointmentStatuses = new Map<string, AppointmentStatus>()): ActivityEventItem => {
  const activityType = row.activity_type as ActivityType;
  const appointmentId = typeof row.appointment_id === "string" ? row.appointment_id : null;
  const currentAppointmentStatus = appointmentId ? appointmentStatuses.get(appointmentId) : undefined;

  return {
    id: String(row.id ?? ""),
    activity_type: activityType,
    title: String(row.title ?? ""),
    description: typeof row.description === "string" ? row.description : null,
    occurred_at: String(row.occurred_at ?? ""),
    client_id: typeof row.client_id === "string" ? row.client_id : null,
    appointment_id: appointmentId,
    ...(currentAppointmentStatus ? { current_appointment_status: currentAppointmentStatus } : {}),
    metadata: normalizeActivityMetadata(activityType, row.metadata, currentAppointmentStatus)
  };
};

const toPendingApprovalActivityItem = (
  appointment: Row,
  client: Row | null,
  timeZone: string
): ActivityEventItem => {
  const clientNames = createClientNameParts(client);
  const appointmentId = String(appointment.id ?? "");
  const appointmentDate = String(appointment.appointment_date ?? "");
  const serviceName = typeof appointment.service_name === "string" ? appointment.service_name : "Appointment";
  const occurredAt = String(appointment.created_at ?? appointment.appointment_date ?? new Date().toISOString());
  const metadata: BookingCreatedActivityMetadata = {
    ...createBookingCreatedMetadata(clientNames, serviceName, appointmentDate),
    current_appointment_status: "pending"
  };

  return {
    id: appointmentId,
    activity_type: "booking_created",
    title: `${clientNames.shortName} booked ${serviceName}`,
    description: `Appointment scheduled for ${formatLocalTime(appointmentDate, timeZone)}`,
    occurred_at: occurredAt,
    client_id: typeof appointment.client_id === "string" ? appointment.client_id : null,
    appointment_id: appointmentId,
    current_appointment_status: "pending",
    metadata
  };
};

const toClientRebookActivityItem = (
  clientId: string,
  client: Row | null,
  lastAppointment: Row
): ActivityEventItem => {
  const clientNames = createClientNameParts(client);
  const lastAppointmentDate = String(lastAppointment.appointment_date ?? "");
  const lastServiceName = typeof lastAppointment.service_name === "string" ? lastAppointment.service_name : null;
  const metadata: ClientRebookNeededActivityMetadata = {
    client_name: clientNames.fullName,
    last_appointment_date: lastAppointmentDate,
    last_service_name: lastServiceName
  };

  return {
    id: clientId,
    activity_type: "client_rebook_needed",
    title: `${clientNames.shortName} is due to rebook`,
    description: lastServiceName ? `Last visit was ${lastServiceName}` : null,
    occurred_at: lastAppointmentDate,
    client_id: clientId,
    appointment_id: null,
    metadata
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
    case "waitlist_joined":
      return "waitlist_joins";
    case "client_rebook_needed":
      return "rebook_needed";
  }
};

const createEmptySummary = (): ActivityGroupSummary => ({
  new_bookings: 0,
  cancellations: 0,
  reschedules: 0,
  reminders_sent: 0,
  waitlist_joins: 0,
  rebook_needed: 0
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

const compareEventsDescending = (left: ActivityEventItem, right: ActivityEventItem): number => {
  if (left.occurred_at !== right.occurred_at) {
    return right.occurred_at.localeCompare(left.occurred_at);
  }

  return right.id.localeCompare(left.id);
};

const encodeCursor = (event: ActivityEventItem, category?: ActivityCategory): string =>
  Buffer.from(JSON.stringify({
    occurred_at: event.occurred_at,
    id: event.id,
    ...(category ? { category } : {})
  } satisfies CursorPayload), "utf8").toString("base64url");

const decodeCursor = (cursor: string, category?: ActivityCategory): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.occurred_at !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor shape");
    }

    if (parsed.category && parsed.category !== category) {
      throw new Error("Cursor category mismatch");
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

const isPendingApprovalActivity = (event: ActivityEventItem): boolean =>
  event.activity_type === "booking_created" && event.current_appointment_status === "pending";

const shouldIncludeEventForCategory = (event: ActivityEventItem, category?: ActivityCategory): boolean => {
  switch (category) {
    case "updates":
      return (
        (
          event.activity_type === "booking_created"
          || event.activity_type === "appointment_cancelled"
          || event.activity_type === "appointment_rescheduled"
        )
        && !isPendingApprovalActivity(event)
      );
    case "waitlist":
      return event.activity_type === "waitlist_joined";
    case "approvals":
      return false;
    case "rebook":
      return event.activity_type === "client_rebook_needed";
    default:
      return event.activity_type !== "client_rebook_needed";
  }
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

const createWaitlistJoinedMetadata = (waitlistEntry: Row): WaitlistJoinedActivityMetadata => {
  const service = isRecord(waitlistEntry.services) ? waitlistEntry.services : null;

  return {
    client_name: String(waitlistEntry.client_name ?? "Client"),
    service_name: typeof service?.name === "string"
      ? service.name
      : typeof waitlistEntry.service_name === "string"
        ? waitlistEntry.service_name
        : null,
    requested_date: String(waitlistEntry.requested_date ?? ""),
    requested_time_preference: typeof waitlistEntry.requested_time_preference === "string"
      ? waitlistEntry.requested_time_preference
      : null,
    source: waitlistEntry.source === "stylist_created" || waitlistEntry.source === "manual"
      ? waitlistEntry.source
      : "public_booking"
  };
};

const getAppointmentIds = (rows: Row[]): string[] =>
  [...new Set(rows
    .map((row) => row.appointment_id)
    .filter((appointmentId): appointmentId is string => typeof appointmentId === "string"))];

const getAppointmentStatuses = async (stylistId: string, rows: Row[]): Promise<Map<string, AppointmentStatus>> => {
  const appointmentIds = getAppointmentIds(rows);
  if (appointmentIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, status")
    .eq("user_id", stylistId)
    .in("id", appointmentIds);

  handleSupabaseError(error, "Unable to load activity appointment statuses");

  return new Map(((data ?? []) as Row[])
    .filter((row) => typeof row.id === "string" && isAppointmentStatus(row.status))
    .map((row) => [row.id as string, row.status as AppointmentStatus]));
};

const getClientsById = async (stylistId: string, clientIds: string[]): Promise<Map<string, Row>> => {
  const uniqueClientIds = [...new Set(clientIds)];
  if (uniqueClientIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, first_name, last_name")
    .eq("user_id", stylistId)
    .in("id", uniqueClientIds);

  handleSupabaseError(error, "Unable to load activity clients");

  return new Map(((data ?? []) as Row[])
    .filter((row) => typeof row.id === "string")
    .map((row) => [row.id as string, row]));
};

const getClientRebookEvents = async (
  stylistId: string,
  timeZone: string,
  filters: Pick<ActivityFeedFilters, "start_date" | "end_date"> = {}
): Promise<ActivityEventItem[]> => {
  const [clientsResult, appointmentsResult] = await Promise.all([
    supabaseAdmin
      .from("clients")
      .select(REBOOK_CLIENT_SELECT)
      .eq("user_id", stylistId),
    supabaseAdmin
      .from("appointments")
      .select(REBOOK_APPOINTMENT_SELECT)
      .eq("user_id", stylistId)
      .neq("status", "cancelled")
      .order("appointment_date", { ascending: true })
  ]);

  handleSupabaseError(clientsResult.error, "Unable to load rebook clients");
  handleSupabaseError(appointmentsResult.error, "Unable to load rebook appointments");

  const clientsById = new Map(((clientsResult.data ?? []) as Row[])
    .filter((client) => typeof client.id === "string")
    .map((client) => [client.id as string, client]));
  const appointmentsByClientId = new Map<string, Row[]>();

  for (const appointment of (appointmentsResult.data ?? []) as Row[]) {
    const clientId = appointment.client_id;
    if (typeof clientId !== "string") {
      continue;
    }

    const existing = appointmentsByClientId.get(clientId) ?? [];
    existing.push(appointment);
    appointmentsByClientId.set(clientId, existing);
  }

  return applyDateFilters([...appointmentsByClientId.entries()]
    .flatMap(([clientId, clientAppointments]) => {
      const { lastQualifyingPastAppointment } = evaluateClientRebookStatus(clientAppointments, timeZone);
      if (!lastQualifyingPastAppointment || typeof lastQualifyingPastAppointment.appointment_date !== "string") {
        return [];
      }

      return [toClientRebookActivityItem(
        clientId,
        clientsById.get(clientId) ?? null,
        lastQualifyingPastAppointment
      )];
    })
    .sort(compareEventsDescending), filters, timeZone, "occurred_at");
};

const applyDateFilters = <T>(
  rows: T[],
  filters: Pick<ActivityFeedFilters, "start_date" | "end_date">,
  timeZone: string,
  column: string
): T[] =>
  rows.filter((row) => {
    const value = String((row as Record<string, unknown>)[column] ?? "");
    if (filters.start_date && value < getStartOfLocalDayUtc(filters.start_date, timeZone).toISOString()) {
      return false;
    }

    if (filters.end_date && value >= getEndOfLocalDayUtc(filters.end_date, timeZone).toISOString()) {
      return false;
    }

    return true;
  });

const withCategoryFields = (
  response: Pick<ActivityFeedResponse, "groups" | "next_cursor">,
  category: ActivityCategory | undefined,
  counts: ActivityFeedCounts | undefined
): ActivityFeedResponse => ({
  ...(category ? { category } : {}),
  ...(counts ? { counts } : {}),
  ...response
});

export const activityEventsService = {
  async getCategoryCounts(
    stylistId: string,
    filters: Pick<ActivityFeedFilters, "start_date" | "end_date">,
    timeZone: string
  ): Promise<ActivityFeedCounts> {
    const activityQuery = supabaseAdmin
      .from("activity_events")
      .select(ACTIVITY_EVENT_SELECT)
      .eq("user_id", stylistId);

    if (filters.start_date) {
      activityQuery.gte("occurred_at", getStartOfLocalDayUtc(filters.start_date, timeZone).toISOString());
    }

    if (filters.end_date) {
      activityQuery.lt("occurred_at", getEndOfLocalDayUtc(filters.end_date, timeZone).toISOString());
    }

    const { data: activityData, error: activityError } = await activityQuery;
    handleSupabaseError(activityError, "Unable to load activity counts");

    const activityRows = (activityData ?? []) as Row[];
    const appointmentStatuses = await getAppointmentStatuses(stylistId, activityRows);
    const activityEvents = activityRows.map((row) => toRowActivityItem(row, appointmentStatuses));

    const appointmentsQuery = supabaseAdmin
      .from("appointments")
      .select(PENDING_APPROVAL_SELECT)
      .eq("user_id", stylistId)
      .eq("status", "pending");

    if (filters.start_date) {
      appointmentsQuery.gte("created_at", getStartOfLocalDayUtc(filters.start_date, timeZone).toISOString());
    }

    if (filters.end_date) {
      appointmentsQuery.lt("created_at", getEndOfLocalDayUtc(filters.end_date, timeZone).toISOString());
    }

    const { data: appointmentData, error: appointmentError } = await appointmentsQuery;
    handleSupabaseError(appointmentError, "Unable to load pending approval counts");

    return {
      updates: activityEvents.filter((event) => shouldIncludeEventForCategory(event, "updates")).length,
      approvals: ((appointmentData ?? []) as Row[]).length,
      waitlist: activityEvents.filter((event) => shouldIncludeEventForCategory(event, "waitlist")).length,
      rebook: (await getClientRebookEvents(stylistId, timeZone, filters)).length
    };
  },

  async getFeed(stylistId: string, filters: ActivityFeedFilters): Promise<ActivityFeedResponse> {
    const timeZone = await businessTimeZoneService.getForUser(stylistId);
    const counts = filters.category ? await this.getCategoryCounts(stylistId, filters, timeZone) : undefined;

    if (filters.category === "approvals") {
      return this.getPendingApprovalsFeed(stylistId, filters, timeZone, counts);
    }

    if (filters.category === "rebook") {
      return this.getClientRebookFeed(stylistId, filters, timeZone, counts);
    }

    if (filters.activity_type === "client_rebook_needed") {
      return this.getClientRebookFeed(stylistId, filters, timeZone, counts);
    }

    let query = supabaseAdmin
      .from("activity_events")
      .select(ACTIVITY_EVENT_SELECT)
      .eq("user_id", stylistId);

    if (filters.category === "waitlist") {
      query = query.eq("activity_type", "waitlist_joined");
    } else if (filters.activity_type) {
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
    const appointmentStatuses = await getAppointmentStatuses(stylistId, sortedRows);
    const sortedEvents = sortedRows
      .map((row) => toRowActivityItem(row, appointmentStatuses))
      .filter((event) => shouldIncludeEventForCategory(event, filters.category));
    const cursor = filters.cursor ? decodeCursor(filters.cursor, filters.category) : null;
    const filteredEvents = cursor
      ? sortedEvents.filter((event) => isBeforeCursor({ occurred_at: event.occurred_at, id: event.id }, cursor))
      : sortedEvents;
    const events = filteredEvents.slice(0, filters.limit);
    const nextCursor = filteredEvents.length > filters.limit && events.length > 0
      ? encodeCursor(events[events.length - 1] as ActivityEventItem, filters.category)
      : null;

    return withCategoryFields({
      groups: groupEventsByDay(events, timeZone),
      next_cursor: nextCursor
    }, filters.category, counts);
  },

  async getPendingApprovalsFeed(
    stylistId: string,
    filters: ActivityFeedFilters,
    timeZone: string,
    counts?: ActivityFeedCounts
  ): Promise<ActivityFeedResponse> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select(PENDING_APPROVAL_SELECT)
      .eq("user_id", stylistId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    handleSupabaseError(error, "Unable to load pending approval activity");

    const sortedRows = applyDateFilters((data ?? []) as Row[], filters, timeZone, "created_at")
      .sort((left, right) => compareRowsDescending({
        ...left,
        occurred_at: left.created_at
      }, {
        ...right,
        occurred_at: right.created_at
      }));
    const cursor = filters.cursor ? decodeCursor(filters.cursor, filters.category) : null;
    const filteredRows = cursor
      ? sortedRows.filter((row) => isBeforeCursor({
        occurred_at: String(row.created_at ?? ""),
        id: String(row.id ?? "")
      }, cursor))
      : sortedRows;
    const pageRows = filteredRows.slice(0, filters.limit);
    const clientsById = await getClientsById(
      stylistId,
      pageRows
        .map((row) => row.client_id)
        .filter((clientId): clientId is string => typeof clientId === "string")
    );
    const events = pageRows.map((row) => toPendingApprovalActivityItem(
      row,
      typeof row.client_id === "string" ? clientsById.get(row.client_id) ?? null : null,
      timeZone
    ));
    const nextCursor = filteredRows.length > filters.limit && events.length > 0
      ? encodeCursor(events[events.length - 1] as ActivityEventItem, filters.category)
      : null;

    return withCategoryFields({
      groups: groupEventsByDay(events, timeZone),
      next_cursor: nextCursor
    }, filters.category, counts);
  },

  async getClientRebookFeed(
    stylistId: string,
    filters: ActivityFeedFilters,
    timeZone: string,
    counts?: ActivityFeedCounts
  ): Promise<ActivityFeedResponse> {
    const sortedEvents = await getClientRebookEvents(stylistId, timeZone, filters);
    const cursor = filters.cursor ? decodeCursor(filters.cursor, filters.category) : null;
    const filteredEvents = cursor
      ? sortedEvents.filter((event) => isBeforeCursor({ occurred_at: event.occurred_at, id: event.id }, cursor))
      : sortedEvents;
    const events = filteredEvents.slice(0, filters.limit);
    const nextCursor = filteredEvents.length > filters.limit && events.length > 0
      ? encodeCursor(events[events.length - 1] as ActivityEventItem, filters.category)
      : null;

    return withCategoryFields({
      groups: groupEventsByDay(events, timeZone),
      next_cursor: nextCursor
    }, filters.category, counts);
  },

  async listByAppointment(stylistId: string, appointmentId: string): Promise<ActivityEventItem[]> {
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id, status")
      .eq("id", appointmentId)
      .eq("user_id", stylistId)
      .maybeSingle();

    handleSupabaseError(appointmentError, "Unable to load appointment activity");
    requireFound(appointment, "Appointment not found");

    const { data, error } = await supabaseAdmin
      .from("activity_events")
      .select(ACTIVITY_EVENT_SELECT)
      .eq("user_id", stylistId)
      .eq("appointment_id", appointmentId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });

    handleSupabaseError(error, "Unable to load appointment activity");
    const appointmentStatuses = isAppointmentStatus((appointment as Row).status)
      ? new Map([[appointmentId, (appointment as Row).status as AppointmentStatus]])
      : new Map<string, AppointmentStatus>();
    return ((data ?? []) as Row[]).sort(compareRowsDescending).map((row) => toRowActivityItem(row, appointmentStatuses));
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

  async recordAppointmentCancelled(
    stylistId: string,
    before: Row,
    after: Row,
    cancelledBy: AppointmentCancelledActivityMetadata["cancelled_by"] = "stylist"
  ): Promise<void> {
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
      metadata: createAppointmentCancelledMetadata(clientNames, serviceName, appointmentDate, cancelledBy),
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

  async recordWaitlistJoined(stylistId: string, waitlistEntry: Row): Promise<void> {
    const clientId = typeof waitlistEntry.client_id === "string" ? waitlistEntry.client_id : null;
    if (!clientId) {
      return;
    }

    const metadata = createWaitlistJoinedMetadata(waitlistEntry);
    const serviceText = metadata.service_name ? ` for ${metadata.service_name}` : "";

    await this.createIfMissing({
      stylistId,
      clientId,
      appointmentId: null,
      activityType: "waitlist_joined",
      title: `${metadata.client_name} joined the waitlist`,
      description: `Requested ${metadata.requested_date}${serviceText}`,
      occurredAt: String(waitlistEntry.created_at ?? new Date().toISOString()),
      metadata,
      dedupeKey: getActivityEventDedupeKey("waitlist_joined", [String(waitlistEntry.id ?? "")])
    });
  },

  async createIfMissing(input: {
    stylistId: string;
    clientId: string;
    appointmentId: string | null;
    activityType: PersistedActivityType;
    title: string;
    description: string | null;
    occurredAt: string;
    metadata: ActivityEventMetadata;
    dedupeKey: string;
  }): Promise<void> {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("activity_events")
      .select("id")
      .eq("user_id", input.stylistId)
      .eq("dedupe_key", input.dedupeKey)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to validate activity event uniqueness");
    if (existing) {
      return;
    }

    const { error } = await supabaseAdmin
      .from("activity_events")
      .insert({
        user_id: input.stylistId,
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
