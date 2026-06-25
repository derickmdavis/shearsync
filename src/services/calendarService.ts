import {
  addDays,
  formatDateInTimeZone,
  formatInstantInTimeZoneOffset,
  getEndOfLocalDayUtc,
  getCurrentLocalDate,
  getMinutesSinceMidnightForInstant,
  getLocalDayOfWeekForDate,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";
import { getAppointmentEndIso } from "../lib/appointments";
import {
  APPOINTMENT_PRICE_FALLBACK_REVENUE_SOURCE,
  calculateAppointmentMetricTotals,
  calculatePercentChange,
  getAppointmentDurationMinutes,
  isAppointmentIncludedInMetric,
  toCents,
  toMetricNumber
} from "../lib/appointmentMetrics";
import { supabaseAdmin } from "../lib/supabase";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { CalendarDayResponse } from "../types/api";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { offDaysService } from "./offDaysService";

interface TimeInterval {
  start: number;
  end: number;
}

const SLOT_INTERVAL_MINUTES = 15;
const MIN_BOOKABLE_GAP_MINUTES = 30;

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const roundUpToInterval = (minutes: number, interval: number): number =>
  Math.ceil(minutes / interval) * interval;

const formatSlotIdTime = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}${String(remainingMinutes).padStart(2, "0")}`;
};

const mergeIntervals = (intervals: TimeInterval[]): TimeInterval[] => {
  const sortedIntervals = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TimeInterval[] = [];

  for (const interval of sortedIntervals) {
    const previous = merged[merged.length - 1];

    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      continue;
    }

    merged.push({ ...interval });
  }

  return merged;
};

const subtractBusyIntervals = (availability: TimeInterval[], busy: TimeInterval[]): TimeInterval[] => {
  let openIntervals = mergeIntervals(availability);

  for (const busyInterval of mergeIntervals(busy)) {
    openIntervals = openIntervals.flatMap((openInterval) => {
      if (busyInterval.end <= openInterval.start || busyInterval.start >= openInterval.end) {
        return [openInterval];
      }

      const nextIntervals: TimeInterval[] = [];

      if (busyInterval.start > openInterval.start) {
        nextIntervals.push({
          start: openInterval.start,
          end: Math.min(busyInterval.start, openInterval.end)
        });
      }

      if (busyInterval.end < openInterval.end) {
        nextIntervals.push({
          start: Math.max(busyInterval.end, openInterval.start),
          end: openInterval.end
        });
      }

      return nextIntervals;
    });
  }

  return openIntervals.filter((interval) => interval.end - interval.start >= MIN_BOOKABLE_GAP_MINUTES);
};

const getAppointmentInterval = (appointment: Row, timeZone: string): TimeInterval | null => {
  if (typeof appointment.appointment_date !== "string") {
    return null;
  }

  const start = getMinutesSinceMidnightForInstant(appointment.appointment_date, timeZone);
  const end = getMinutesSinceMidnightForInstant(
    getAppointmentEndIso(appointment.appointment_date, getAppointmentDurationMinutes(appointment)),
    timeZone
  );

  if (end <= start) {
    return null;
  }

  return { start, end };
};

const getRevenueComparisonPercent = (bookedRevenue: number, previousBookedRevenue: number): number | null => {
  return calculatePercentChange(bookedRevenue, previousBookedRevenue);
};

const toCalendarAppointment = (appointment: Row): Row => {
  const client = (appointment.client ?? null) as Row | null;
  const firstName = typeof client?.first_name === "string" ? client.first_name : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name : "";
  const clientName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const appointmentDate = typeof appointment.appointment_date === "string" ? appointment.appointment_date : null;
  const durationMinutes = getAppointmentDurationMinutes(appointment);
  const startTime = appointmentDate;
  const endTime = appointmentDate
    ? new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString()
    : null;
  const serviceName = typeof appointment.service_name === "string" ? appointment.service_name : null;
  const price = toMetricNumber(appointment.price);

  return {
    ...appointment,
    start_time: startTime,
    end_time: endTime,
    services: serviceName ? [serviceName] : [],
    revenue: price,
    revenue_source: APPOINTMENT_PRICE_FALLBACK_REVENUE_SOURCE,
    price,
    client_name: clientName,
    location: null
  };
};

const dedupeAppointments = (appointments: Row[]): Row[] => {
  const uniqueAppointments = new Map<string, Row>();

  for (const appointment of appointments) {
    const id = typeof appointment.id === "string" ? appointment.id : null;

    if (!id || uniqueAppointments.has(id)) {
      continue;
    }

    uniqueAppointments.set(id, appointment);
  }

  return Array.from(uniqueAppointments.values());
};

export const calendarService = {
  async getDay(userId: string, dateText: string): Promise<CalendarDayResponse> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const dayStart = getStartOfLocalDayUtc(dateText, timeZone);
    const dayEnd = getEndOfLocalDayUtc(dateText, timeZone);
    const localDayOfWeek = getLocalDayOfWeekForDate(dateText, timeZone);

    const previousWeekDate = addDays(dateText, -7);
    const previousWeekStart = getStartOfLocalDayUtc(previousWeekDate, timeZone);
    const previousWeekEnd = getEndOfLocalDayUtc(previousWeekDate, timeZone);

    const [appointmentsResult, previousWeekAppointmentsResult, availabilityResult, isOffDay] = await Promise.all([
      supabaseAdmin
        .from("appointments")
        .select(
          `
            id,
            client_id,
            appointment_date,
            service_name,
            duration_minutes,
            price,
            notes,
            status,
            client:clients!appointments_client_id_fkey (
              id,
              first_name,
              last_name
            )
          `
        )
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .gte("appointment_date", dayStart.toISOString())
        .lt("appointment_date", dayEnd.toISOString())
        .order("appointment_date", { ascending: true }),
      supabaseAdmin
        .from("appointments")
        .select("appointment_date, duration_minutes, price, status")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .gte("appointment_date", previousWeekStart.toISOString())
        .lt("appointment_date", previousWeekEnd.toISOString()),
      supabaseAdmin
        .from("availability")
        .select("start_time, end_time")
        .eq("user_id", userId)
        .eq("day_of_week", localDayOfWeek)
        .eq("is_active", true),
      offDaysService.isOffDay(userId, dateText)
    ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load calendar appointments");
    handleSupabaseError(previousWeekAppointmentsResult.error, "Unable to load calendar comparison appointments");
    handleSupabaseError(availabilityResult.error, "Unable to load calendar availability");

    const appointments = dedupeAppointments((appointmentsResult.data ?? []).map((row) => toCalendarAppointment(row as Row))).sort(
      (left, right) => {
        const leftTime = typeof left.start_time === "string" ? Date.parse(left.start_time) : 0;
        const rightTime = typeof right.start_time === "string" ? Date.parse(right.start_time) : 0;
        return leftTime - rightTime;
      }
    );
    const selectedBookedTotals = calculateAppointmentMetricTotals(appointments, "booked_revenue");
    const previousBookedTotals = calculateAppointmentMetricTotals((previousWeekAppointmentsResult.data ?? []) as Row[], "booked_revenue");
    const today = getCurrentLocalDate(timeZone);
    const availabilityIntervals = mergeIntervals((availabilityResult.data ?? []).map((window) => ({
      start: typeof window.start_time === "string" ? timeToMinutes(window.start_time) : 0,
      end: typeof window.end_time === "string" ? timeToMinutes(window.end_time) : 0
    })));
    const busyIntervals = appointments
      .filter((appointment) => isAppointmentIncludedInMetric(appointment, "busy_time"))
      .map((appointment) => getAppointmentInterval(appointment, timeZone))
      .filter((interval): interval is TimeInterval => interval !== null);
    const now = new Date();
    const openIntervals = dateText < today || isOffDay
      ? []
      : subtractBusyIntervals(availabilityIntervals, busyIntervals)
        .map((interval) => {
          if (dateText !== today) {
            return interval;
          }

          return {
            start: Math.max(interval.start, roundUpToInterval(getMinutesSinceMidnightForInstant(now.toISOString(), timeZone), SLOT_INTERVAL_MINUTES)),
            end: interval.end
          };
        })
        .filter((interval) => interval.end - interval.start >= MIN_BOOKABLE_GAP_MINUTES);
    const availableSlots = openIntervals.map((interval) => {
      const startUtc = zonedDateTimeToUtc(
        dateText,
        timeZone,
        Math.floor(interval.start / 60),
        interval.start % 60,
        0,
        0
      );
      const endUtc = zonedDateTimeToUtc(
        dateText,
        timeZone,
        Math.floor(interval.end / 60),
        interval.end % 60,
        0,
        0
      );

      return {
        id: `slot-${dateText}-${formatSlotIdTime(interval.start)}`,
        startTime: formatInstantInTimeZoneOffset(startUtc, timeZone),
        endTime: formatInstantInTimeZoneOffset(endUtc, timeZone),
        durationMinutes: interval.end - interval.start,
        canBook: true
      };
    });
    const freeMinutesRemaining = openIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const openGapCount = availableSlots.length;

    return {
      date: dateText,
      appointments,
      availableSlots,
      summary: {
        selectedDateLabel: formatDateInTimeZone(
          zonedDateTimeToUtc(dateText, timeZone, 12, 0, 0, 0),
          timeZone,
          {
            weekday: "long",
            month: "long",
            day: "numeric"
          }
        ),
        totalAppointments: appointments.length,
        bookedRevenueCents: toCents(selectedBookedTotals.revenue),
        bookedMinutes: selectedBookedTotals.minutes,
        comparisonVsLastWeekPercent: getRevenueComparisonPercent(
          selectedBookedTotals.revenue,
          previousBookedTotals.revenue
        ),
        freeMinutesRemaining,
        openGapCount
      }
    };
  }
};
