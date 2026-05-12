import { createPublicAppointmentManagementToken } from "../lib/publicAppointmentManagement";
import { env } from "../config/env";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { usersService } from "./usersService";

export type AppointmentEmailType =
  | "appointment_scheduled"
  | "appointment_pending"
  | "appointment_confirmed"
  | "appointment_cancelled"
  | "appointment_rescheduled";

interface QueueAppointmentEmailOptions {
  cancelledBy?: "client" | "stylist";
  recipientEmail?: string | null;
}

interface AppointmentEmailTemplateData {
  recipient_name: string;
  service_name: string;
  appointment_start_time: string;
  appointment_end_time: string;
  appointment_start_display: string;
  appointment_end_display: string;
  appointment_time_display: string;
  duration_minutes: number;
  business_timezone: string;
  stylist_display_name: string | null;
  business_name: string | null;
  business_display_name: string;
  business_phone: string | null;
  business_email: string | null;
  management_token: string;
  management_url: string | null;
  cancelled_by?: "client" | "stylist";
  status?: string;
}

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const getAppointmentEmailIdempotencyKey = (
  emailType: AppointmentEmailType,
  appointmentId: string,
  appointmentStartTime?: string
): string =>
  emailType === "appointment_rescheduled" && appointmentStartTime
    ? `${emailType}:${appointmentId}:${appointmentStartTime}`
    : `${emailType}:${appointmentId}`;

const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const getRecipientName = (client: Row): string => {
  const firstName = typeof client.first_name === "string" ? client.first_name.trim() : "";
  const lastName = typeof client.last_name === "string" ? client.last_name.trim() : "";
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Client";
};

const getAppointmentEndIso = (appointmentStartTime: string, durationMinutes: number): string =>
  new Date(new Date(appointmentStartTime).getTime() + durationMinutes * 60_000).toISOString();

const getStringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const formatAppointmentDate = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(instant));

const formatAppointmentTime = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(instant));

const getAppointmentManagementUrl = (managementToken: string): string | null => {
  const baseUrl = env.WEB_APP_URL ?? env.CLIENT_APP_URL;

  if (!baseUrl) {
    return null;
  }

  return `${baseUrl.replace(/\/+$/, "")}/appointments/manage/${encodeURIComponent(managementToken)}`;
};

const loadStylist = async (stylistId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("stylists")
    .select("display_name")
    .eq("user_id", stylistId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load appointment email stylist");
  return data;
};

const buildTemplateData = async ({
  stylistId,
  client,
  appointment,
  managementToken,
  emailType,
  options
}: {
  stylistId: string;
  client: Row;
  appointment: Row;
  managementToken: string;
  emailType: AppointmentEmailType;
  options: QueueAppointmentEmailOptions;
}): Promise<AppointmentEmailTemplateData> => {
  const [user, stylist, timeZone] = await Promise.all([
    usersService.getById(stylistId),
    loadStylist(stylistId),
    businessTimeZoneService.getForUser(stylistId)
  ]);
  const appointmentStartTime = String(appointment.appointment_date ?? "");
  const durationMinutes = Number(appointment.duration_minutes ?? 0);
  const appointmentEndTime = getAppointmentEndIso(appointmentStartTime, durationMinutes);
  const appointmentStartDisplay = formatAppointmentDate(appointmentStartTime, timeZone);
  const appointmentEndDisplay = formatAppointmentTime(appointmentEndTime, timeZone);
  const stylistDisplayName = getStringOrNull(stylist?.display_name);
  const businessName = getStringOrNull(user?.business_name);
  const businessEmail = normalizeEmail(user?.email);
  const businessDisplayName =
    businessName
    ?? stylistDisplayName
    ?? getStringOrNull(user?.full_name)
    ?? businessEmail
    ?? "Your stylist";

  return {
    recipient_name: getRecipientName(client),
    service_name: String(appointment.service_name ?? "Appointment"),
    appointment_start_time: appointmentStartTime,
    appointment_end_time: appointmentEndTime,
    appointment_start_display: appointmentStartDisplay,
    appointment_end_display: appointmentEndDisplay,
    appointment_time_display: `${appointmentStartDisplay} - ${appointmentEndDisplay}`,
    duration_minutes: durationMinutes,
    business_timezone: timeZone,
    stylist_display_name: stylistDisplayName,
    business_name: businessName,
    business_display_name: businessDisplayName,
    business_phone: getStringOrNull(user?.phone_number),
    business_email: businessEmail,
    management_token: managementToken,
    management_url: getAppointmentManagementUrl(managementToken),
    ...(emailType === "appointment_cancelled"
      ? { cancelled_by: options.cancelledBy ?? "stylist" }
      : {}),
    ...(emailType === "appointment_rescheduled"
      ? { status: String(appointment.status ?? "") }
      : {})
  };
};

export const appointmentEmailEventsService = {
  getIdempotencyKey: getAppointmentEmailIdempotencyKey,

  async queueAppointmentEmail(
    stylistId: string,
    appointment: Row,
    emailType: AppointmentEmailType,
    options: QueueAppointmentEmailOptions = {}
  ): Promise<Row | null> {
    const appointmentId = String(appointment.id ?? "");
    const clientId = String(appointment.client_id ?? "");
    const appointmentStartTime = String(appointment.appointment_date ?? "");
    const idempotencyKey = getAppointmentEmailIdempotencyKey(emailType, appointmentId, appointmentStartTime);

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("appointment_email_events")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to validate appointment email uniqueness");
    if (existing) {
      return existing;
    }

    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("id", clientId)
      .eq("user_id", stylistId)
      .maybeSingle();

    handleSupabaseError(clientError, "Unable to load appointment email recipient");

    const recipientEmail = normalizeEmail(options.recipientEmail) ?? normalizeEmail(client?.email);
    if (!client || !recipientEmail) {
      return null;
    }

    const managementToken = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId,
      appointmentStartTime
    });
    const templateData = await buildTemplateData({
      stylistId,
      client,
      appointment,
      managementToken,
      emailType,
      options
    });

    const { data, error } = await supabaseAdmin
      .from("appointment_email_events")
      .insert({
        stylist_id: stylistId,
        client_id: clientId,
        appointment_id: appointmentId,
        email_type: emailType,
        recipient_email: recipientEmail,
        status: "queued",
        idempotency_key: idempotencyKey,
        template_data: templateData
      })
      .select("*")
      .single();

    if (isUniqueViolation(error)) {
      const { data: existingAfterConflict, error: conflictLoadError } = await supabaseAdmin
        .from("appointment_email_events")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      handleSupabaseError(conflictLoadError, "Unable to load existing appointment email");
      return existingAfterConflict ?? null;
    }

    handleSupabaseError(error, "Unable to queue appointment email");
    return data;
  }
};
