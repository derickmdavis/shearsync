import { ApiError, requireFound } from "../lib/errors";
import { formatDateInTimeZone, formatInstantInTimeZoneOffset, getEndOfLocalDayUtc, getStartOfLocalDayUtc, zonedDateTimeToUtc } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { InternalAppointmentContext, BookingSource } from "../types/api";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import { activityEventsService } from "./activityEventsService";

const appointmentSlotConflictMessage = "This time slot is already booked.";
const appointmentSlotConstraintName = "appointments_user_id_appointment_date_active_idx";
const internalSlotIntervalMinutes = 15;

const isAppointmentSlotConflictError = (error: { code?: string; message?: string; details?: string } | null): boolean => {
  if (!error || error.code !== "23505") {
    return false;
  }

  const errorText = `${error.message ?? ""} ${error.details ?? ""}`;
  return (
    errorText.includes(appointmentSlotConstraintName) ||
    errorText.includes("(user_id, appointment_date)")
  );
};

const toDurationMinutes = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getAppointmentEndIso = (appointmentDate: string, durationMinutes: number): string =>
  new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString();

const formatTimeText = (minutes: number): { hour: number; minute: number } => ({
  hour: Math.floor(minutes / 60),
  minute: minutes % 60
});

const appointmentsOverlap = (
  appointmentDate: string,
  durationMinutes: number,
  existingDate: string,
  existingDurationMinutes: number
): boolean => appointmentDate < getAppointmentEndIso(existingDate, existingDurationMinutes)
  && getAppointmentEndIso(appointmentDate, durationMinutes) > existingDate;

const toContextTimeRange = (appointment: Row, timeZone: string): { start: string; end: string } => {
  const appointmentDate = appointment.appointment_date as string;
  const durationMinutes = toDurationMinutes(appointment.duration_minutes);

  return {
    start: formatInstantInTimeZoneOffset(appointmentDate, timeZone),
    end: formatInstantInTimeZoneOffset(getAppointmentEndIso(appointmentDate, durationMinutes), timeZone)
  };
};

export const appointmentsService = {
  async findMatchingPublicBooking(
    userId: string,
    {
      clientId,
      appointmentDate,
      serviceName,
      durationMinutes
    }: {
      clientId: string;
      appointmentDate: string;
      serviceName: string;
      durationMinutes: number;
    }
  ): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .eq("appointment_date", appointmentDate)
      .eq("service_name", serviceName)
      .eq("duration_minutes", durationMinutes)
      .eq("booking_source", "public")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load matching public booking");
    return data ?? null;
  },

  async getInternalContext(userId: string, dateText: string, durationMinutes: number): Promise<InternalAppointmentContext> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("id, appointment_date, duration_minutes")
      .eq("user_id", userId)
      .neq("status", "cancelled")
      .gte("appointment_date", getStartOfLocalDayUtc(dateText, timeZone).toISOString())
      .lt("appointment_date", getEndOfLocalDayUtc(dateText, timeZone).toISOString())
      .order("appointment_date", { ascending: true });

    handleSupabaseError(error, "Unable to load internal appointment context");
    const existingAppointments = (data ?? []) as RowList;
    const availableSlots: InternalAppointmentContext["availableSlots"] = [];

    for (
      let candidateMinutes = 0;
      candidateMinutes + durationMinutes <= 24 * 60;
      candidateMinutes += internalSlotIntervalMinutes
    ) {
      const { hour, minute } = formatTimeText(candidateMinutes);
      const candidateUtc = zonedDateTimeToUtc(dateText, timeZone, hour, minute, 0, 0);
      const candidateIso = candidateUtc.toISOString();
      const hasConflict = existingAppointments.some((appointment) =>
        appointmentsOverlap(
          candidateIso,
          durationMinutes,
          appointment.appointment_date as string,
          toDurationMinutes(appointment.duration_minutes)
        )
      );

      if (hasConflict) {
        continue;
      }

      availableSlots.push({
        start: formatInstantInTimeZoneOffset(candidateUtc, timeZone),
        end: formatInstantInTimeZoneOffset(getAppointmentEndIso(candidateIso, durationMinutes), timeZone),
        label: formatDateInTimeZone(candidateUtc, timeZone, {
          hour: "numeric",
          minute: "2-digit"
        })
      });
    }

    return {
      date: dateText,
      availableSlots,
      existingAppointments: existingAppointments.map((appointment) => toContextTimeRange(appointment, timeZone)),
      blockedTimes: []
    };
  },

  async listByClient(userId: string, clientId: string): Promise<RowList> {
    await clientsService.assertOwned(userId, clientId);

    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .order("appointment_date", { ascending: false });

    handleSupabaseError(error, "Unable to load appointments");
    return data ?? [];
  },

  async getOwned(userId: string, appointmentId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment");
    return requireFound(data, "Appointment not found");
  },

  async create(userId: string, payload: Row): Promise<Row> {
    await clientsService.assertOwned(userId, payload.client_id as string);
    const bookingSource = (payload.booking_source as BookingSource | undefined) ?? "internal";

    if (payload.status !== "cancelled") {
      const conflict = await this.hasSlotConflict(
        userId,
        payload.appointment_date as string,
        toDurationMinutes(payload.duration_minutes)
      );

      if (conflict) {
        throw new ApiError(409, appointmentSlotConflictMessage);
      }
    }

    const { data, error } = await supabaseAdmin
      .from("appointments")
      .insert({ ...payload, booking_source: bookingSource, user_id: userId })
      .select("*")
      .single();

    if (isAppointmentSlotConflictError(error)) {
      throw new ApiError(409, appointmentSlotConflictMessage);
    }

    handleSupabaseError(error, "Unable to create appointment");
    const appointment = requireFound(data, "Appointment was not created");
    await activityEventsService.recordBookingCreated(userId, appointment);
    return appointment;
  },

  async update(userId: string, appointmentId: string, updates: Row): Promise<Row> {
    const existingAppointment = { ...(await this.getOwned(userId, appointmentId)) };

    if (updates.client_id) {
      await clientsService.assertOwned(userId, updates.client_id as string);
    }

    if (
      updates.appointment_date !== undefined ||
      updates.duration_minutes !== undefined ||
      updates.status !== undefined
    ) {
      const nextAppointmentDate = (updates.appointment_date as string | undefined)
        ?? (existingAppointment.appointment_date as string);
      const nextDurationMinutes = toDurationMinutes(
        updates.duration_minutes ?? existingAppointment.duration_minutes
      );
      const nextStatus = (updates.status as string | undefined) ?? (existingAppointment.status as string | undefined);

      if (nextStatus !== "cancelled") {
        const conflict = await this.hasSlotConflict(userId, nextAppointmentDate, nextDurationMinutes, appointmentId);

        if (conflict) {
          throw new ApiError(409, appointmentSlotConflictMessage);
        }
      }
    }

    const { data, error } = await supabaseAdmin
      .from("appointments")
      .update(updates)
      .eq("id", appointmentId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (isAppointmentSlotConflictError(error)) {
      throw new ApiError(409, appointmentSlotConflictMessage);
    }

    handleSupabaseError(error, "Unable to update appointment");
    const updatedAppointment = requireFound(data, "Appointment not found");

    if (
      existingAppointment.status !== "cancelled" &&
      updatedAppointment.status === "cancelled"
    ) {
      await activityEventsService.recordAppointmentCancelled(userId, existingAppointment, updatedAppointment);
      return updatedAppointment;
    }

    if (
      updatedAppointment.status !== "cancelled" &&
      (
        existingAppointment.appointment_date !== updatedAppointment.appointment_date ||
        existingAppointment.duration_minutes !== updatedAppointment.duration_minutes
      )
    ) {
      await activityEventsService.recordAppointmentRescheduled(userId, existingAppointment, updatedAppointment);
    }

    return updatedAppointment;
  },

  async hasSlotConflict(
    userId: string,
    appointmentDate: string,
    durationMinutes: number,
    excludedAppointmentId?: string
  ): Promise<boolean> {
    let query = supabaseAdmin
      .from("appointments")
      .select("id, appointment_date, duration_minutes")
      .eq("user_id", userId)
      .neq("status", "cancelled");

    if (excludedAppointmentId) {
      query = query.neq("id", excludedAppointmentId);
    }

    const { data, error } = await query;

    handleSupabaseError(error, "Unable to validate appointment slot");
    return Boolean(
      data?.some((appointment) =>
        appointmentsOverlap(
          appointmentDate,
          durationMinutes,
          appointment.appointment_date as string,
          toDurationMinutes(appointment.duration_minutes)
        )
      )
    );
  },

  async createForBooking(userId: string, payload: Row): Promise<Row> {
    const conflict = await this.hasSlotConflict(
      userId,
      payload.appointment_date as string,
      toDurationMinutes(payload.duration_minutes)
    );

    if (conflict) {
      throw new ApiError(409, "Requested time is no longer available");
    }

    return this.create(userId, { ...payload, booking_source: "public" });
  },

  async applyPendingDecision(userId: string, appointmentId: string, decision: "accept" | "reject"): Promise<Row> {
    const appointment = await this.getOwned(userId, appointmentId);

    if (appointment.status !== "pending") {
      throw new ApiError(400, "Only pending appointments can be accepted or rejected");
    }

    return this.update(userId, appointmentId, {
      status: decision === "accept" ? "scheduled" : "cancelled"
    });
  }
};
