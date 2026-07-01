import { addDays, formatDateInTimeZone, getLocalDateForInstant, zonedDateTimeToUtc } from "../lib/timezone";
import { appointmentImagesService } from "./appointmentImagesService";
import { appointmentsService } from "./appointmentsService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientRebookingPreferencesService } from "./clientRebookingPreferencesService";
import { clientsService } from "./clientsService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { rebookNudgeSettingsService } from "./rebookNudgeSettingsService";
import { supabaseAdmin } from "../lib/supabase";

const toString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDisplayName = (client: Row): string => {
  const preferredName = toString(client.preferred_name);
  if (preferredName) {
    return preferredName;
  }

  return [toString(client.first_name), toString(client.last_name)].filter(Boolean).join(" ").trim();
};

const toAvatarInitials = (client: Row): string => {
  const displayName = toDisplayName(client);
  const nameParts = displayName.split(/\s+/).filter(Boolean);

  if (nameParts.length === 0) {
    return "";
  }

  return nameParts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
};

const formatDateLabel = (instant: string | null, timeZone: string): string | null => {
  if (!instant) {
    return null;
  }

  return formatDateInTimeZone(new Date(instant), timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
};

const formatAppointmentWhenLabel = (instant: string | null, timeZone: string): string | null => {
  if (!instant) {
    return null;
  }

  return formatDateInTimeZone(new Date(instant), timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
};

const formatDurationLabel = (durationMinutes: unknown): string | null => {
  const minutes = toNumber(durationMinutes);
  if (minutes <= 0) {
    return null;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) {
    return `${remainingMinutes} min`;
  }

  if (remainingMinutes === 0) {
    return hours === 1 ? "1 hr" : `${hours} hr`;
  }

  return `${hours} hr ${remainingMinutes} min`;
};

const daysBetween = (earlierInstant: string, laterInstant: string): number => {
  const milliseconds = new Date(laterInstant).getTime() - new Date(earlierInstant).getTime();
  return Math.round(milliseconds / (24 * 60 * 60 * 1000));
};

const averageCompletedVisitSpacing = (completedAppointments: RowList): number | null => {
  if (completedAppointments.length < 2) {
    return null;
  }

  const gaps: number[] = [];
  for (let index = 1; index < completedAppointments.length; index += 1) {
    const previousDate = completedAppointments[index - 1]?.appointment_date;
    const currentDate = completedAppointments[index]?.appointment_date;

    if (typeof previousDate === "string" && typeof currentDate === "string") {
      gaps.push(daysBetween(previousDate, currentDate));
    }
  }

  if (gaps.length === 0) {
    return null;
  }

  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
};

const buildSnapshot = (client: Row, appointments: RowList, timeZone: string) => {
  const completedAppointments = getCompletedAppointments(appointments);
  const lastCompletedAppointment = completedAppointments[completedAppointments.length - 1] ?? null;
  const lastVisitAt = (lastCompletedAppointment?.appointment_date as string | undefined)
    ?? (typeof client.last_visit_at === "string" ? client.last_visit_at : null);
  const totalSpentFromAppointments = completedAppointments.reduce(
    (sum, appointment) => sum + toNumber(appointment.price),
    0
  );
  const totalSpent = completedAppointments.length > 0
    ? totalSpentFromAppointments
    : toNumber(client.total_spend);
  const totalCompletedVisits = completedAppointments.length;
  const averageTicket = totalCompletedVisits > 0 ? Math.round((totalSpent / totalCompletedVisits) * 100) / 100 : null;

  return {
    last_visit_at: lastVisitAt,
    last_visit_label: formatDateLabel(lastVisitAt, timeZone),
    total_completed_visits: totalCompletedVisits,
    average_days_between_visits: averageCompletedVisitSpacing(completedAppointments),
    total_spent: Math.round(totalSpent * 100) / 100,
    average_ticket: averageTicket,
    member_since: typeof client.created_at === "string" ? client.created_at : null,
    member_since_label: formatDateLabel(typeof client.created_at === "string" ? client.created_at : null, timeZone)
  };
};

const getCompletedAppointments = (appointments: RowList): RowList =>
  appointments
    .filter((appointment) => appointment.status === "completed" && typeof appointment.appointment_date === "string")
    .sort((left, right) => String(left.appointment_date).localeCompare(String(right.appointment_date)));

const getNextAppointment = (appointments: RowList, now = new Date()): Row | null => {
  const nowIso = now.toISOString();

  return appointments.find((appointment) =>
    appointment.status !== "cancelled"
    && typeof appointment.appointment_date === "string"
    && appointment.appointment_date > nowIso
  ) ?? null;
};

const buildNextAppointmentSummary = (appointment: Row | null, timeZone: string) => {
  if (!appointment) {
    return null;
  }

  const appointmentDate = typeof appointment.appointment_date === "string" ? appointment.appointment_date : null;

  return {
    when_label: formatAppointmentWhenLabel(appointmentDate, timeZone),
    duration_label: formatDurationLabel(appointment.duration_minutes),
    status_label: "Upcoming appointment",
    status_tone: "success"
  };
};

const buildStatusSummary = ({
  completedAppointments,
  nextAppointment
}: {
  completedAppointments: RowList;
  nextAppointment: Row | null;
}) => {
  if (nextAppointment) {
    return {
      status_label: "Upcoming appointment",
      status_tone: "success"
    };
  }

  if (completedAppointments.length > 0) {
    return {
      status_label: "Ready to rebook",
      status_tone: "warning"
    };
  }

  return {
    status_label: "No appointment history",
    status_tone: "neutral"
  };
};

const buildValueSummary = ({
  completedAppointments,
  nextAppointment,
  snapshot
}: {
  completedAppointments: RowList;
  nextAppointment: Row | null;
  snapshot: {
    total_completed_visits: number;
    total_spent: number;
    average_ticket: number | null;
  };
}) => {
  const lastCompletedAppointment = completedAppointments[completedAppointments.length - 1] ?? null;
  const hasFutureAfterLatestCompleted = Boolean(
    nextAppointment
    && typeof nextAppointment.appointment_date === "string"
    && typeof lastCompletedAppointment?.appointment_date === "string"
    && nextAppointment.appointment_date > lastCompletedAppointment.appointment_date
  );
  const rebookingRate = completedAppointments.length === 0
    ? null
    : hasFutureAfterLatestCompleted ? 100 : 0;
  const completedVisitText = snapshot.total_completed_visits === 1
    ? "1 completed visit"
    : `${snapshot.total_completed_visits} completed visits`;

  if (hasFutureAfterLatestCompleted) {
    return {
      total_spent: snapshot.total_spent,
      average_ticket: snapshot.average_ticket,
      rebooking_rate: rebookingRate,
      trend_label: "Active client",
      trend_detail: `${completedVisitText} with an upcoming appointment`
    };
  }

  if (completedAppointments.length > 0) {
    return {
      total_spent: snapshot.total_spent,
      average_ticket: snapshot.average_ticket,
      rebooking_rate: rebookingRate,
      trend_label: "Ready to rebook",
      trend_detail: completedVisitText
    };
  }

  return {
    total_spent: snapshot.total_spent,
    average_ticket: snapshot.average_ticket,
    rebooking_rate: rebookingRate,
    trend_label: "New client",
    trend_detail: "No completed visits yet"
  };
};

const buildRebookingPreference = ({
  completedAppointments,
  defaultIntervalDays,
  overridePreference,
  timeZone
}: {
  completedAppointments: RowList;
  defaultIntervalDays: number;
  overridePreference: Row | null;
  timeZone: string;
}) => {
  const lastCompletedAppointment = completedAppointments[completedAppointments.length - 1] ?? null;
  const lastVisitAt = typeof lastCompletedAppointment?.appointment_date === "string"
    ? lastCompletedAppointment.appointment_date
    : null;
  const averageIntervalDays = averageCompletedVisitSpacing(completedAppointments);
  const overrideIntervalDays = overridePreference ? toNumber(overridePreference.preferred_interval_days) : null;
  const preferredIntervalDays = overrideIntervalDays ?? averageIntervalDays ?? defaultIntervalDays;
  const source = overrideIntervalDays !== null ? "manual" : averageIntervalDays === null ? "default" : "auto";
  const basisVisitCount = source === "auto" ? Math.min(completedAppointments.length, 5) : completedAppointments.length;
  const basisVisitCountLabel = source === "manual"
    ? "Manual override"
    : source === "auto"
      ? `Based on last ${basisVisitCount} visits`
      : completedAppointments.length === 1
        ? "Based on 1 completed visit"
        : "Account default";
  const lastVisitDate = lastVisitAt ? getLocalDateForInstant(lastVisitAt, timeZone) : null;
  const nextRecommendedDate = lastVisitDate ? addDays(lastVisitDate, preferredIntervalDays) : null;
  const nextRecommendedAt = nextRecommendedDate
    ? zonedDateTimeToUtc(nextRecommendedDate, timeZone, 12, 0, 0, 0).toISOString()
    : null;

  return {
    preferred_interval_days: preferredIntervalDays,
    next_recommended_date: nextRecommendedDate,
    next_recommended_label: formatDateLabel(nextRecommendedAt, timeZone),
    basis_label: overrideIntervalDays !== null
      ? `Based on the manually set ${overrideIntervalDays}-day rebooking interval`
      : lastVisitAt
        ? `Based on the last completed visit on ${formatDateLabel(lastVisitAt, timeZone)}`
        : `Based on the default ${defaultIntervalDays}-day rebooking interval`,
    basis_visit_count: basisVisitCount,
    basis_visit_count_label: basisVisitCountLabel,
    source,
    is_overridden: overrideIntervalDays !== null
  };
};

export const clientsDetailService = {
  async getDetail(userId: string, clientId: string) {
    const [
      client,
      timeZone,
      appointmentsResult,
      rebookSettings,
      rebookingOverride,
      recentHistory,
      visualHistory
    ] = await Promise.all([
        clientsService.getById(userId, clientId),
        businessTimeZoneService.getForUser(userId),
        supabaseAdmin
          .from("appointments")
          .select("id, client_id, appointment_date, service_name, duration_minutes, price, status, booking_source, created_at")
          .eq("user_id", userId)
          .eq("client_id", clientId)
          .order("appointment_date", { ascending: true }),
        rebookNudgeSettingsService.getRawForUser(userId),
        clientRebookingPreferencesService.getForClient(userId, clientId),
        appointmentsService.listByClientPaginated(userId, clientId, {
          status: "past",
          limit: 3
        }),
        appointmentImagesService.listClientVisualHistory(userId, clientId, {
          limit: 6
        })
      ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load client detail appointments");
    const appointments = appointmentsResult.data ?? [];
    const completedAppointments = getCompletedAppointments(appointments);
    const nextAppointment = getNextAppointment(appointments);
    const snapshot = buildSnapshot(client, appointments, timeZone);
    const avatarImageId = typeof client.avatar_image_id === "string" ? client.avatar_image_id : null;
    const avatarUrl = await appointmentImagesService.getClientAvatarUrl(userId, clientId, avatarImageId);
    const defaultIntervalDays = Number(
      rebookSettings?.default_rebook_interval_days ?? rebookNudgeSettingsService.defaultIntervalDays
    );

    return {
      client,
      identity: {
        display_name: toDisplayName(client),
        avatar_url: avatarUrl,
        avatar_image_id: avatarImageId,
        avatar_initials: toAvatarInitials(client),
        is_vip: client.is_vip === true
      },
      snapshot,
      rebooking_preference: buildRebookingPreference({
        completedAppointments,
        defaultIntervalDays,
        overridePreference: rebookingOverride,
        timeZone
      }),
      next_appointment: nextAppointment,
      next_appointment_summary: buildNextAppointmentSummary(nextAppointment, timeZone),
      status_summary: buildStatusSummary({
        completedAppointments,
        nextAppointment
      }),
      value_summary: buildValueSummary({
        completedAppointments,
        nextAppointment,
        snapshot
      }),
      recent_history: recentHistory,
      visual_history: visualHistory
    };
  }
};
