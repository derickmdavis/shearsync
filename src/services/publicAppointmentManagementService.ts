import { ApiError, requireFound } from "../lib/errors";
import { getAppointmentEndIso } from "../lib/appointments";
import {
  formatInstantInTimeZoneOffset,
  zonedDateTimeToUtc
} from "../lib/timezone";
import {
  resolvePublicAppointmentManagementToken
} from "../lib/publicAppointmentManagement";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { appointmentsService } from "./appointmentsService";
import { appointmentEmailEventsService } from "./appointmentEmailEventsService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { schedulingPolicyService } from "./schedulingPolicyService";
import { usersService } from "./usersService";

export interface PublicManagedAppointment {
  appointment_id: string;
  client_id: string;
  stylist_id: string;
  stylist_slug: string | null;
  stylist_display_name: string;
  business_name: string | null;
  client_name: string;
  service_name: string;
  service_duration_minutes: number;
  service_price: number;
  appointment_date: string;
  appointment_end: string;
  business_timezone: string;
  status: string;
  can_cancel: boolean;
  can_reschedule: boolean;
}

interface ManagedAppointmentContext {
  appointment: Row;
  client: Row;
  stylist: Row | null;
  user: Row | null;
  timeZone: string;
}

const invalidManagementLinkMessage = "Appointment management link is invalid or expired";
const requestedDateTimePattern = /^(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<millisecond>\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})$/;

const normalizeRequestedDateTimeForBusinessTimeZone = (
  requestedDateTime: string,
  timeZone: string
): string => {
  const match = requestedDateTimePattern.exec(requestedDateTime);

  if (!match?.groups) {
    throw new ApiError(400, "Requested datetime is invalid");
  }

  const secondText = match.groups.second ?? "00";
  const millisecondText = match.groups.millisecond ?? "0";
  const millisecond = Number(millisecondText.padEnd(3, "0").slice(0, 3));

  return zonedDateTimeToUtc(
    match.groups.date,
    timeZone,
    Number(match.groups.hour),
    Number(match.groups.minute),
    Number(secondText),
    millisecond
  ).toISOString();
};

const getClientName = (client: Row): string => {
  const firstName = typeof client.first_name === "string" ? client.first_name.trim() : "";
  const lastName = typeof client.last_name === "string" ? client.last_name.trim() : "";
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Client";
};

const assertManageableAppointment = (appointment: Row): void => {
  if (appointment.status === "cancelled") {
    throw new ApiError(400, "Appointment can no longer be managed");
  }

  const appointmentDate = typeof appointment.appointment_date === "string"
    ? appointment.appointment_date
    : "";

  if (!appointmentDate || new Date(appointmentDate) <= new Date()) {
    throw new ApiError(400, invalidManagementLinkMessage);
  }
};

const assertActionableAppointment = (appointment: Row): void => {
  const status = appointment.status as string | undefined;

  if (status !== "pending" && status !== "scheduled") {
    throw new ApiError(400, "Appointment can no longer be managed");
  }
};

const hasCompletedAppointment = async (
  stylistId: string,
  clientId: string
): Promise<boolean> => {
  const { count, error } = await supabaseAdmin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", stylistId)
    .eq("client_id", clientId)
    .eq("status", "completed");

  handleSupabaseError(error, "Unable to validate client appointment history");
  return Number(count ?? 0) > 0;
};

const toManagedAppointment = ({
  appointment,
  client,
  stylist,
  user,
  timeZone
}: ManagedAppointmentContext): PublicManagedAppointment => {
  const appointmentDate = String(appointment.appointment_date ?? "");
  const durationMinutes = Number(appointment.duration_minutes ?? 0);
  const status = String(appointment.status ?? "");
  const isActionable = status === "scheduled" || status === "pending";

  return {
    appointment_id: String(appointment.id ?? ""),
    client_id: String(appointment.client_id ?? ""),
    stylist_id: String(appointment.user_id ?? ""),
    stylist_slug: typeof stylist?.slug === "string" ? stylist.slug : null,
    stylist_display_name: typeof stylist?.display_name === "string" ? stylist.display_name : "",
    business_name: (user?.business_name as string | null | undefined) ?? null,
    client_name: getClientName(client),
    service_name: String(appointment.service_name ?? "Appointment"),
    service_duration_minutes: durationMinutes,
    service_price: Number(appointment.price ?? 0),
    appointment_date: appointmentDate,
    appointment_end: formatInstantInTimeZoneOffset(getAppointmentEndIso(appointmentDate, durationMinutes), timeZone),
    business_timezone: timeZone,
    status,
    can_cancel: isActionable,
    can_reschedule: isActionable
  };
};

export const publicAppointmentManagementService = {
  async getManagedAppointment(token: string): Promise<PublicManagedAppointment> {
    const context = await this.loadManagedAppointmentContext(token);
    return toManagedAppointment(context);
  },

  async cancelManagedAppointment(token: string): Promise<PublicManagedAppointment> {
    const context = await this.loadManagedAppointmentContext(token);
    assertActionableAppointment(context.appointment);
    const updatedAppointment = await appointmentsService.update(
      String(context.appointment.user_id ?? ""),
      String(context.appointment.id ?? ""),
      { status: "cancelled" },
      { cancelledBy: "client" }
    );

    return toManagedAppointment({
      ...context,
      appointment: updatedAppointment
    });
  },

  async rescheduleManagedAppointment(token: string, payload: Row): Promise<PublicManagedAppointment> {
    const context = await this.loadManagedAppointmentContext(token);
    assertActionableAppointment(context.appointment);

    const stylistId = String(context.appointment.user_id ?? "");
    const clientId = String(context.appointment.client_id ?? "");
    const requestedDateTime = normalizeRequestedDateTimeForBusinessTimeZone(
      payload.requested_datetime as string,
      context.timeZone
    );
    const durationMinutes = Number(context.appointment.duration_minutes ?? 0);
    const isExistingClient = await hasCompletedAppointment(stylistId, clientId);
    const slotEvaluation = await schedulingPolicyService.evaluateRequestedSlot({
      userId: stylistId,
      requestedDateTime,
      durationMinutes,
      isExistingClient,
      mode: "reschedule",
      currentAppointmentId: String(context.appointment.id ?? ""),
      currentAppointmentStart: String(context.appointment.appointment_date ?? ""),
      currentAppointmentStatus: String(context.appointment.status ?? ""),
      timeZone: context.timeZone
    });

    if (!slotEvaluation.ok) {
      throw new ApiError(slotEvaluation.statusCode, slotEvaluation.message);
    }

    const updatedAppointment = await appointmentsService.update(
      stylistId,
      String(context.appointment.id ?? ""),
      {
        appointment_date: requestedDateTime,
        status: slotEvaluation.status
      }
    );

    await appointmentEmailEventsService.queueAppointmentEmail(
      stylistId,
      updatedAppointment,
      "appointment_rescheduled"
    );

    return toManagedAppointment({
      ...context,
      appointment: updatedAppointment
    });
  },

  async loadManagedAppointmentContext(token: string): Promise<ManagedAppointmentContext> {
    const tokenContext = resolvePublicAppointmentManagementToken(token);
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select("*")
      .eq("id", tokenContext.appointmentId)
      .maybeSingle();

    handleSupabaseError(appointmentError, "Unable to load managed appointment");
    const resolvedAppointment = requireFound(appointment, invalidManagementLinkMessage);

    if (
      resolvedAppointment.user_id !== tokenContext.stylistId ||
      resolvedAppointment.client_id !== tokenContext.clientId ||
      resolvedAppointment.appointment_date !== tokenContext.appointmentStartTime
    ) {
      throw new ApiError(400, invalidManagementLinkMessage);
    }

    assertManageableAppointment(resolvedAppointment);

    const [{ data: client, error: clientError }, { data: stylist, error: stylistError }, user, timeZone] =
      await Promise.all([
        supabaseAdmin
          .from("clients")
          .select("*")
          .eq("id", tokenContext.clientId)
          .eq("user_id", tokenContext.stylistId)
          .maybeSingle(),
        supabaseAdmin
          .from("stylists")
          .select("*")
          .eq("user_id", tokenContext.stylistId)
          .maybeSingle(),
        usersService.getById(tokenContext.stylistId),
        businessTimeZoneService.getForUser(tokenContext.stylistId)
      ]);

    handleSupabaseError(clientError, "Unable to load managed appointment client");
    handleSupabaseError(stylistError, "Unable to load managed appointment stylist");

    return {
      appointment: resolvedAppointment,
      client: requireFound(client, invalidManagementLinkMessage),
      stylist,
      user,
      timeZone
    };
  }
};
