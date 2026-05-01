import {
  formatDateInTimeZone,
  getEndOfLocalDayUtc,
  getLocalDayOfWeekForDate,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const toNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toCalendarAppointment = (appointment: Row): Row => {
  const client = (appointment.client ?? null) as Row | null;
  const firstName = typeof client?.first_name === "string" ? client.first_name : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name : "";
  const clientName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const appointmentDate = typeof appointment.appointment_date === "string" ? appointment.appointment_date : null;
  const durationMinutes = toNumber(appointment.duration_minutes);
  const startTime = appointmentDate;
  const endTime = appointmentDate
    ? new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString()
    : null;
  const serviceName = typeof appointment.service_name === "string" ? appointment.service_name : null;
  const price = toNumber(appointment.price);

  return {
    ...appointment,
    start_time: startTime,
    end_time: endTime,
    services: serviceName ? [serviceName] : [],
    revenue: price,
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
  async getDay(userId: string, dateText: string): Promise<Row> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const dayStart = getStartOfLocalDayUtc(dateText, timeZone);
    const dayEnd = getEndOfLocalDayUtc(dateText, timeZone);
    const localDayOfWeek = getLocalDayOfWeekForDate(dateText, timeZone);

    const [appointmentsResult, availabilityResult] = await Promise.all([
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
        .from("availability")
        .select("start_time, end_time")
        .eq("user_id", userId)
        .eq("day_of_week", localDayOfWeek)
        .eq("is_active", true)
    ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load calendar appointments");
    handleSupabaseError(availabilityResult.error, "Unable to load calendar availability");

    const appointments = dedupeAppointments((appointmentsResult.data ?? []).map((row) => toCalendarAppointment(row as Row))).sort(
      (left, right) => {
        const leftTime = typeof left.start_time === "string" ? Date.parse(left.start_time) : 0;
        const rightTime = typeof right.start_time === "string" ? Date.parse(right.start_time) : 0;
        return leftTime - rightTime;
      }
    );
    const bookedRevenue = appointments.reduce((sum, appointment) => sum + toNumber(appointment.revenue), 0);
    const bookedMinutes = appointments.reduce((sum, appointment) => sum + toNumber(appointment.duration_minutes), 0);
    const availableMinutes = (availabilityResult.data ?? []).reduce((sum, window) => {
      const start = typeof window.start_time === "string" ? timeToMinutes(window.start_time) : 0;
      const end = typeof window.end_time === "string" ? timeToMinutes(window.end_time) : 0;
      return sum + Math.max(0, end - start);
    }, 0);
    const openSlots = Math.max(0, Math.floor((availableMinutes - bookedMinutes) / 60));

    return {
      date: dateText,
      appointments,
      summary: {
        selected_date_label: formatDateInTimeZone(
          zonedDateTimeToUtc(dateText, timeZone, 12, 0, 0, 0),
          timeZone,
          {
            weekday: "long",
            month: "long",
            day: "numeric"
          }
        ),
        total_appointments: appointments.length,
        booked_revenue: bookedRevenue,
        open_slots: openSlots
      }
    };
  }
};
