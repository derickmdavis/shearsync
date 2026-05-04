import {
  addDays,
  formatInstantInTimeZoneOffset,
  getCurrentLocalDate,
  getEndOfLocalDayUtc,
  getLocalDateForInstant,
  getLocalDayOfWeekForDate,
  getLocalDayOfWeekForInstant,
  getMinutesSinceMidnightForInstant,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";
import { ApiError } from "../lib/errors";
import { resolvePublicBookingContextToken } from "../lib/publicBookingContext";
import { supabaseAdmin } from "../lib/supabase";
import type {
  AvailabilityClientAudience,
  AvailabilityDaySettings,
  AvailabilitySettingsResponse,
  AvailabilityWindowInput,
  PublicAvailabilitySlot,
  PublicAvailabilitySlotsResponse
} from "../types/api";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { bookingRulesService } from "./bookingRulesService";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const SLOT_INTERVAL_MINUTES = 15;
const availabilityAudienceOrder: Record<AvailabilityClientAudience, number> = {
  all: 0,
  new: 1,
  returning: 2
};

const formatTimeText = (minutes: number): { hour: number; minute: number } => ({
  hour: Math.floor(minutes / 60),
  minute: minutes % 60
});

const getAppointmentEndIso = (appointmentDate: string, durationMinutes: number): string =>
  new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString();

const overlaps = (
  startIso: string,
  durationMinutes: number,
  existingStartIso: string,
  existingDurationMinutes: number
): boolean => {
  const endIso = getAppointmentEndIso(startIso, durationMinutes);
  const existingEndIso = getAppointmentEndIso(existingStartIso, existingDurationMinutes);
  return startIso < existingEndIso && endIso > existingStartIso;
};

const getNewClientRuleViolation = (localDate: string, today: string, bookingWindowDays: number) => {
  if (bookingWindowDays === 0) {
    return null;
  }

  if (localDate > addDays(today, bookingWindowDays)) {
    return `New clients can only book up to ${bookingWindowDays} day(s) in advance`;
  }

  return null;
};

const isAfterCutoff = (currentMinutes: number, cutoffTime: string): boolean => currentMinutes > timeToMinutes(cutoffTime);

interface AvailabilityWindow extends Row {
  id?: string;
  day_of_week?: number;
  start_time: string;
  end_time: string;
  is_active?: boolean;
  client_audience?: AvailabilityClientAudience | null;
}

interface AppointmentSummary extends Row {
  appointment_date: string;
  duration_minutes: number;
}

const dayIndexes = [0, 1, 2, 3, 4, 5, 6];

const formatTimeForApi = (time: string): string => time.slice(0, 5);

const normalizeAvailabilityAudience = (value: unknown): AvailabilityClientAudience =>
  value === "new" || value === "returning" ? value : "all";

const getAllowedAudiences = (isExistingClient: boolean): AvailabilityClientAudience[] =>
  isExistingClient ? ["all", "returning"] : ["all", "new"];

const filterWindowsForAudience = (
  rows: AvailabilityWindow[],
  isExistingClient: boolean
): AvailabilityWindow[] => {
  const allowedAudiences = new Set(getAllowedAudiences(isExistingClient));
  return rows.filter((row) => allowedAudiences.has(normalizeAvailabilityAudience(row.client_audience)));
};

const normalizeWindow = (window: AvailabilityWindowInput): AvailabilityWindowInput => ({
  startTime: formatTimeForApi(window.startTime),
  endTime: formatTimeForApi(window.endTime),
  clientAudience: normalizeAvailabilityAudience(window.clientAudience)
});

const assertValidWindows = (dayOfWeek: number, windows: AvailabilityWindowInput[]) => {
  const normalizedWindows = windows
    .map(normalizeWindow)
    .sort((left, right) =>
      availabilityAudienceOrder[left.clientAudience] - availabilityAudienceOrder[right.clientAudience]
      || left.startTime.localeCompare(right.startTime)
    );

  const perAudience = new Map<AvailabilityClientAudience, AvailabilityWindowInput[]>();

  for (const window of normalizedWindows) {
    const audienceWindows = perAudience.get(window.clientAudience) ?? [];

    if (timeToMinutes(window.startTime) >= timeToMinutes(window.endTime)) {
      throw new ApiError(400, `Availability window start must be before end for day ${dayOfWeek}`);
    }

    const previous = audienceWindows[audienceWindows.length - 1];

    if (previous && timeToMinutes(window.startTime) < timeToMinutes(previous.endTime)) {
      throw new ApiError(400, `Availability windows cannot overlap for day ${dayOfWeek} and audience ${window.clientAudience}`);
    }

    audienceWindows.push(window);
    perAudience.set(window.clientAudience, audienceWindows);
  }

  return normalizedWindows;
};

export const mapAvailabilityRowsToSettings = (
  rows: AvailabilityWindow[],
  timeZone: string
): AvailabilitySettingsResponse => {
  const activeRows = rows
    .filter((row) => row.is_active !== false)
    .sort((left, right) => {
      const leftDay = Number(left.day_of_week ?? 0);
      const rightDay = Number(right.day_of_week ?? 0);
      return leftDay - rightDay
        || left.start_time.localeCompare(right.start_time)
        || availabilityAudienceOrder[normalizeAvailabilityAudience(left.client_audience)]
          - availabilityAudienceOrder[normalizeAvailabilityAudience(right.client_audience)];
    });

  const grouped = new Map<number, AvailabilityWindow[]>();

  for (const row of activeRows) {
    const dayOfWeek = Number(row.day_of_week ?? 0);
    const dayRows = grouped.get(dayOfWeek) ?? [];
    dayRows.push(row);
    grouped.set(dayOfWeek, dayRows);
  }

  const days: AvailabilityDaySettings[] = dayIndexes.map((dayOfWeek) => {
    const windows = (grouped.get(dayOfWeek) ?? []).map((row) => ({
      startTime: formatTimeForApi(row.start_time),
      endTime: formatTimeForApi(row.end_time),
      clientAudience: normalizeAvailabilityAudience(row.client_audience)
    }));

    return {
      dayOfWeek,
      isOpen: windows.length > 0,
      windows
    };
  });

  return {
    timezone: timeZone,
    days
  };
};

export const availabilityService = {
  async listActiveByStylistSlug(
    slug: string,
    options?: {
      bookingContextToken?: string;
    }
  ): Promise<RowList> {
    const stylist = await stylistsService.getBySlug(slug);
    stylistsService.assertPublicBookingEnabled(stylist);

    const { data, error } = await supabaseAdmin
      .from("availability")
      .select("*")
      .eq("user_id", stylist.user_id)
      .eq("is_active", true)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    handleSupabaseError(error, "Unable to load availability");
    const bookingContext = resolvePublicBookingContextToken(options?.bookingContextToken, slug);
    const isExistingClient = bookingContext?.isExistingClient ?? false;
    return filterWindowsForAudience((data ?? []) as AvailabilityWindow[], isExistingClient);
  },

  async listActiveForUserOnDay(
    userId: string,
    dayOfWeek: number,
    options?: {
      isExistingClient?: boolean;
    }
  ): Promise<AvailabilityWindow[]> {
    const { data, error } = await supabaseAdmin
      .from("availability")
      .select("*")
      .eq("user_id", userId)
      .eq("day_of_week", dayOfWeek)
      .eq("is_active", true)
      .order("start_time", { ascending: true });

    handleSupabaseError(error, "Unable to validate availability");
    const rows = (data ?? []) as AvailabilityWindow[];
    if (options?.isExistingClient === undefined) {
      return rows;
    }

    return filterWindowsForAudience(rows, options.isExistingClient);
  },

  async getWeeklyForUser(userId: string): Promise<AvailabilitySettingsResponse> {
    const [timeZone, rows] = await Promise.all([
      businessTimeZoneService.getForUser(userId),
      supabaseAdmin
        .from("availability")
        .select("*")
        .eq("user_id", userId)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true })
    ]);

    handleSupabaseError(rows.error, "Unable to load availability settings");
    return mapAvailabilityRowsToSettings((rows.data ?? []) as AvailabilityWindow[], timeZone);
  },

  async replaceWeeklyForUser(userId: string, days: AvailabilityDaySettings[]): Promise<AvailabilitySettingsResponse> {
    const dayMap = new Map(days.map((day) => [day.dayOfWeek, day]));
    const rowsToInsert: Array<{
      user_id: string;
      day_of_week: number;
      start_time: string;
      end_time: string;
      is_active: boolean;
      client_audience: AvailabilityClientAudience;
    }> = [];

    for (const dayOfWeek of dayIndexes) {
      const day = dayMap.get(dayOfWeek) ?? {
        dayOfWeek,
        isOpen: false,
        windows: []
      };
      const normalizedWindows = assertValidWindows(dayOfWeek, day.windows);

      if (!day.isOpen && normalizedWindows.length > 0) {
        throw new ApiError(400, `Closed day ${dayOfWeek} cannot include availability windows`);
      }

      if (day.isOpen && normalizedWindows.length === 0) {
        throw new ApiError(400, `Open day ${dayOfWeek} must include at least one availability window`);
      }

      for (const window of normalizedWindows) {
        rowsToInsert.push({
          user_id: userId,
          day_of_week: dayOfWeek,
          start_time: window.startTime,
          end_time: window.endTime,
          is_active: true,
          client_audience: window.clientAudience
        });
      }
    }

    const deleteResult = await supabaseAdmin.from("availability").delete().eq("user_id", userId).select("*");
    handleSupabaseError(deleteResult.error, "Unable to replace availability settings");

    if (rowsToInsert.length > 0) {
      const insertResult = await supabaseAdmin.from("availability").insert(rowsToInsert).select("*");
      handleSupabaseError(insertResult.error, "Unable to replace availability settings");
    }

    return this.getWeeklyForUser(userId);
  },

  async listActiveAppointmentsForLocalDate(userId: string, dateText: string, timeZone: string): Promise<AppointmentSummary[]> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("appointment_date, duration_minutes, status")
      .eq("user_id", userId)
      .neq("status", "cancelled")
      .gte("appointment_date", getStartOfLocalDayUtc(dateText, timeZone).toISOString())
      .lt("appointment_date", getEndOfLocalDayUtc(dateText, timeZone).toISOString())
      .order("appointment_date", { ascending: true });

    handleSupabaseError(error, "Unable to load daily appointments");
    return (data ?? []) as AppointmentSummary[];
  },

  async isRequestedTimeAvailable(
    userId: string,
    requestedDateTime: string,
    durationMinutes: number,
    isExistingClient = false
  ): Promise<boolean> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const dayOfWeek = getLocalDayOfWeekForInstant(requestedDateTime, timeZone);
    const requestedMinutes = getMinutesSinceMidnightForInstant(requestedDateTime, timeZone);
    const requestedEndMinutes = requestedMinutes + durationMinutes;
    const windows = await this.listActiveForUserOnDay(userId, dayOfWeek, { isExistingClient });

    return windows.some((window) => {
      const start = timeToMinutes(window.start_time);
      const end = timeToMinutes(window.end_time);
      return requestedMinutes >= start && requestedEndMinutes <= end;
    });
  },

  async getBookableSlotsByStylistSlug(
    slug: string,
    serviceId: string,
    dateText: string,
    bookingContextToken?: string
  ): Promise<PublicAvailabilitySlotsResponse> {
    const stylist = await stylistsService.getBySlug(slug);
    stylistsService.assertPublicBookingEnabled(stylist);
    const userId = stylist.user_id as string;
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const service = await servicesService.getActiveForStylist(userId, serviceId);

    if (!service) {
      throw new ApiError(400, "Selected service is not available");
    }

    const bookingRules = await bookingRulesService.getByUserId(userId);
    const localDayOfWeek = getLocalDayOfWeekForDate(dateText, timeZone);
    const today = getCurrentLocalDate(timeZone);
    const bookingContext = resolvePublicBookingContextToken(bookingContextToken, slug);
    const isExistingClient = bookingContext?.isExistingClient ?? false;
    const windows = await this.listActiveForUserOnDay(userId, localDayOfWeek, { isExistingClient });
    const appointments = await this.listActiveAppointmentsForLocalDate(userId, dateText, timeZone);
    const serviceDuration = Number(service.duration_minutes ?? 0);
    const slotStarts = new Set<string>();
    const slots: PublicAvailabilitySlot[] = [];
    const now = new Date();
    const currentLocalDate = getCurrentLocalDate(timeZone, now);
    const currentLocalMinutes = getMinutesSinceMidnightForInstant(now.toISOString(), timeZone);

    for (const window of windows) {
      const windowStart = timeToMinutes(window.start_time);
      const windowEnd = timeToMinutes(window.end_time);

      for (let candidateMinutes = windowStart; candidateMinutes + serviceDuration <= windowEnd; candidateMinutes += SLOT_INTERVAL_MINUTES) {
        const { hour, minute } = formatTimeText(candidateMinutes);
        const candidateUtc = zonedDateTimeToUtc(dateText, timeZone, hour, minute, 0, 0);
        const candidateIso = candidateUtc.toISOString();

        if (slotStarts.has(candidateIso)) {
          continue;
        }

        if (candidateUtc <= now) {
          continue;
        }

        if (!bookingRules.sameDayBookingAllowed && dateText === currentLocalDate) {
          continue;
        }

        if (
          bookingRules.sameDayBookingAllowed &&
          dateText === currentLocalDate &&
          isAfterCutoff(currentLocalMinutes, bookingRules.sameDayBookingCutoff)
        ) {
          continue;
        }

        const localDate = getLocalDateForInstant(candidateIso, timeZone);
        if (localDate > addDays(today, bookingRules.maxBookingWindowDays)) {
          continue;
        }

        const leadTimeCutoff = new Date(now.getTime() + bookingRules.leadTimeHours * 60 * 60_000);
        if (candidateUtc < leadTimeCutoff) {
          continue;
        }

        if (!isExistingClient) {
          if (
            bookingRules.restrictServicesForNewClients &&
            bookingRules.restrictedServiceIds.includes(serviceId)
          ) {
            continue;
          }

          if (getNewClientRuleViolation(localDate, today, bookingRules.newClientBookingWindowDays)) {
            continue;
          }
        }

        const hasConflict = appointments.some((appointment) =>
          overlaps(
            candidateIso,
            serviceDuration,
            appointment.appointment_date,
            Number(appointment.duration_minutes ?? 0)
          )
        );

        if (hasConflict) {
          continue;
        }

        slotStarts.add(candidateIso);
        slots.push({
          start: formatInstantInTimeZoneOffset(candidateUtc, timeZone),
          end: formatInstantInTimeZoneOffset(getAppointmentEndIso(candidateIso, serviceDuration), timeZone)
        });
      }
    }

    return {
      date: dateText,
      timezone: timeZone,
      service: {
        id: service.id as string,
        name: service.name as string,
        duration_minutes: serviceDuration,
        price: Number(service.price ?? 0)
      },
      slots
    };
  }
};
