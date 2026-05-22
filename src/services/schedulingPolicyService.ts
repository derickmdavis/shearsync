import {
  addDays,
  getCurrentLocalDate,
  getLocalDateForInstant,
  getLocalDayOfWeekForInstant,
  getMinutesSinceMidnightForInstant
} from "../lib/timezone";
import { appointmentsOverlap } from "../lib/appointments";
import type { AvailabilityClientAudience, BookingSettings } from "../types/api";
import { appointmentsService } from "./appointmentsService";
import { bookingRulesService } from "./bookingRulesService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { offDaysService } from "./offDaysService";
import { supabaseAdmin } from "../lib/supabase";

const slotIntervalMinutes = 15;
const requestedTimeUnavailableMessage = "Requested time is no longer available";

interface AvailabilityWindow extends Row {
  start_time: string;
  end_time: string;
  client_audience?: AvailabilityClientAudience | null;
}

interface AppointmentSummary extends Row {
  id?: string;
  appointment_date: string;
  duration_minutes: number;
}

interface EvaluateRequestedSlotOptions {
  userId: string;
  requestedDateTime: string;
  durationMinutes: number;
  isExistingClient: boolean;
  mode: "booking" | "reschedule";
  serviceId?: string;
  currentAppointmentId?: string;
  currentAppointmentStart?: string;
  currentAppointmentStatus?: string;
  timeZone?: string;
  bookingRules?: BookingSettings;
  windows?: AvailabilityWindow[];
  appointments?: AppointmentSummary[];
  isOffDay?: boolean;
  now?: Date;
}

export type SlotEvaluation =
  | { ok: true; status: "pending" | "scheduled" }
  | {
    ok: false;
    statusCode: 400 | 409;
    message: string;
    reason:
      | "slot_not_on_grid"
      | "past_time"
      | "reschedule_window"
      | "lead_time"
      | "max_booking_window"
      | "same_day_booking"
      | "same_day_reschedule"
      | "same_day_cutoff"
      | "new_client_booking_window"
      | "restricted_service"
      | "off_day"
      | "outside_availability"
      | "appointment_conflict";
  };

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

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

const listActiveWindowsForUserOnDay = async (
  userId: string,
  dayOfWeek: number,
  isExistingClient: boolean
): Promise<AvailabilityWindow[]> => {
  const { data, error } = await supabaseAdmin
    .from("availability")
    .select("*")
    .eq("user_id", userId)
    .eq("day_of_week", dayOfWeek)
    .eq("is_active", true)
    .order("start_time", { ascending: true });

  handleSupabaseError(error, "Unable to validate availability");
  return filterWindowsForAudience((data ?? []) as AvailabilityWindow[], isExistingClient);
};

const isOnBookableSlotGrid = (requestedDateTime: string, timeZone: string): boolean => {
  const requestedDate = new Date(requestedDateTime);
  const requestedMinutes = getMinutesSinceMidnightForInstant(requestedDateTime, timeZone);
  return requestedMinutes % slotIntervalMinutes === 0
    && requestedDate.getUTCSeconds() === 0
    && requestedDate.getUTCMilliseconds() === 0;
};

const getStatusForAllowedSlot = (
  mode: EvaluateRequestedSlotOptions["mode"],
  rules: BookingSettings,
  isExistingClient: boolean,
  currentAppointmentStatus?: string
): "pending" | "scheduled" => {
  if (mode === "reschedule" && currentAppointmentStatus === "pending") {
    return "pending";
  }

  return !isExistingClient && rules.newClientApprovalRequired ? "pending" : "scheduled";
};

export const schedulingPolicyService = {
  async evaluateRequestedSlot(options: EvaluateRequestedSlotOptions): Promise<SlotEvaluation> {
    const {
      userId,
      requestedDateTime,
      durationMinutes,
      isExistingClient,
      mode,
      serviceId,
      currentAppointmentId,
      currentAppointmentStart,
      currentAppointmentStatus
    } = options;
    const [timeZone, rules] = await Promise.all([
      options.timeZone ? Promise.resolve(options.timeZone) : businessTimeZoneService.getForUser(userId),
      options.bookingRules ? Promise.resolve(options.bookingRules) : bookingRulesService.getByUserId(userId)
    ]);
    const now = options.now ?? new Date();
    const requestedDate = new Date(requestedDateTime);
    const requestedLocalDate = getLocalDateForInstant(requestedDateTime, timeZone);
    const today = getCurrentLocalDate(timeZone, now);

    if (!isOnBookableSlotGrid(requestedDateTime, timeZone)) {
      return { ok: false, statusCode: 409, message: requestedTimeUnavailableMessage, reason: "slot_not_on_grid" };
    }

    if (requestedDate <= now) {
      return { ok: false, statusCode: 400, message: "Requested time must be in the future", reason: "past_time" };
    }

    if (mode === "reschedule") {
      const currentAppointmentDate = new Date(String(currentAppointmentStart ?? ""));
      if (currentAppointmentDate.getTime() - now.getTime() < rules.rescheduleWindowHours * 60 * 60_000) {
        return {
          ok: false,
          statusCode: 400,
          message: `Appointments require at least ${rules.rescheduleWindowHours} hour(s) of notice to reschedule`,
          reason: "reschedule_window"
        };
      }
    }

    const leadTimeThreshold = new Date(now.getTime() + rules.leadTimeHours * 60 * 60_000);
    if (requestedDate < leadTimeThreshold) {
      return {
        ok: false,
        statusCode: 400,
        message: `Appointments require at least ${rules.leadTimeHours} hour(s) of notice`,
        reason: "lead_time"
      };
    }

    if (requestedLocalDate > addDays(today, rules.maxBookingWindowDays)) {
      return {
        ok: false,
        statusCode: 400,
        message: `Appointments can only be booked up to ${rules.maxBookingWindowDays} day(s) in advance`,
        reason: "max_booking_window"
      };
    }

    if (requestedLocalDate === today) {
      if (mode === "booking" && !rules.sameDayBookingAllowed) {
        return { ok: false, statusCode: 400, message: "Same-day booking is not allowed", reason: "same_day_booking" };
      }

      if (mode === "reschedule" && !rules.sameDayReschedulingAllowed) {
        return { ok: false, statusCode: 400, message: "Same-day rescheduling is not allowed", reason: "same_day_reschedule" };
      }

      const currentLocalMinutes = getMinutesSinceMidnightForInstant(now.toISOString(), timeZone);
      if (currentLocalMinutes > timeToMinutes(rules.sameDayBookingCutoff)) {
        return { ok: false, statusCode: 400, message: "The same-day booking cutoff has passed", reason: "same_day_cutoff" };
      }
    }

    if (!isExistingClient) {
      if (
        rules.newClientBookingWindowDays > 0 &&
        requestedLocalDate > addDays(today, rules.newClientBookingWindowDays)
      ) {
        return {
          ok: false,
          statusCode: 400,
          message: `New clients can only book up to ${rules.newClientBookingWindowDays} day(s) in advance`,
          reason: "new_client_booking_window"
        };
      }

      if (
        mode === "booking" &&
        serviceId &&
        rules.restrictServicesForNewClients &&
        rules.restrictedServiceIds.includes(serviceId)
      ) {
        return {
          ok: false,
          statusCode: 400,
          message: "This service is not available for new clients online",
          reason: "restricted_service"
        };
      }
    }

    const isOffDay = options.isOffDay ?? await offDaysService.isOffDay(userId, requestedLocalDate);
    if (isOffDay) {
      return { ok: false, statusCode: 409, message: requestedTimeUnavailableMessage, reason: "off_day" };
    }

    const dayOfWeek = getLocalDayOfWeekForInstant(requestedDateTime, timeZone);
    const requestedMinutes = getMinutesSinceMidnightForInstant(requestedDateTime, timeZone);
    const requestedEndMinutes = requestedMinutes + durationMinutes;
    const windows = options.windows ?? await listActiveWindowsForUserOnDay(userId, dayOfWeek, isExistingClient);
    const fitsAvailability = windows.some((window) => {
      const start = timeToMinutes(window.start_time);
      const end = timeToMinutes(window.end_time);
      return requestedMinutes >= start && requestedEndMinutes <= end;
    });

    if (!fitsAvailability) {
      return { ok: false, statusCode: 409, message: requestedTimeUnavailableMessage, reason: "outside_availability" };
    }

    const hasConflict = options.appointments
      ? options.appointments.some((appointment) =>
        appointment.id !== currentAppointmentId &&
        appointmentsOverlap(
          requestedDateTime,
          durationMinutes,
          appointment.appointment_date,
          Number(appointment.duration_minutes ?? 0)
        )
      )
      : await appointmentsService.hasSlotConflict(
        userId,
        requestedDateTime,
        durationMinutes,
        currentAppointmentId
      );

    if (hasConflict) {
      return { ok: false, statusCode: 409, message: requestedTimeUnavailableMessage, reason: "appointment_conflict" };
    }

    return {
      ok: true,
      status: getStatusForAllowedSlot(mode, rules, isExistingClient, currentAppointmentStatus)
    };
  }
};
