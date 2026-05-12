import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "./errors";

const PUBLIC_APPOINTMENT_MANAGEMENT_ISSUER = "shearsync-public-booking";
const PUBLIC_APPOINTMENT_MANAGEMENT_AUDIENCE = "public-appointment-management";
const PUBLIC_APPOINTMENT_MANAGEMENT_TYPE = "public_appointment_management";
const PUBLIC_APPOINTMENT_MANAGEMENT_PURPOSE = "manage_appointment";

interface PublicAppointmentManagementClaims extends jwt.JwtPayload {
  typ: typeof PUBLIC_APPOINTMENT_MANAGEMENT_TYPE;
  purpose: typeof PUBLIC_APPOINTMENT_MANAGEMENT_PURPOSE;
  appointment_id: string;
  client_id: string;
  stylist_id: string;
  appointment_start_time: string;
}

export interface PublicAppointmentManagementContext {
  appointmentId: string;
  clientId: string;
  stylistId: string;
  appointmentStartTime: string;
}

const getPublicAppointmentManagementSecret = (): string => env.SUPABASE_JWT_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

const getAppointmentStartExpiration = (appointmentStartTime: string): number => {
  const timestamp = new Date(appointmentStartTime).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new ApiError(400, "Appointment start time is invalid");
  }

  return Math.floor(timestamp / 1000);
};

export const createPublicAppointmentManagementToken = (
  context: PublicAppointmentManagementContext
): string =>
  jwt.sign(
    {
      typ: PUBLIC_APPOINTMENT_MANAGEMENT_TYPE,
      purpose: PUBLIC_APPOINTMENT_MANAGEMENT_PURPOSE,
      appointment_id: context.appointmentId,
      client_id: context.clientId,
      stylist_id: context.stylistId,
      appointment_start_time: context.appointmentStartTime,
      exp: getAppointmentStartExpiration(context.appointmentStartTime)
    },
    getPublicAppointmentManagementSecret(),
    {
      algorithm: "HS256",
      audience: PUBLIC_APPOINTMENT_MANAGEMENT_AUDIENCE,
      issuer: PUBLIC_APPOINTMENT_MANAGEMENT_ISSUER
    }
  );

export const resolvePublicAppointmentManagementToken = (
  token: string | undefined
): PublicAppointmentManagementContext => {
  if (!token) {
    throw new ApiError(400, "Appointment management link is invalid or expired");
  }

  try {
    const payload = jwt.verify(token, getPublicAppointmentManagementSecret(), {
      algorithms: ["HS256"],
      audience: PUBLIC_APPOINTMENT_MANAGEMENT_AUDIENCE,
      issuer: PUBLIC_APPOINTMENT_MANAGEMENT_ISSUER
    }) as PublicAppointmentManagementClaims;

    if (
      payload.typ !== PUBLIC_APPOINTMENT_MANAGEMENT_TYPE ||
      payload.purpose !== PUBLIC_APPOINTMENT_MANAGEMENT_PURPOSE ||
      typeof payload.appointment_id !== "string" ||
      typeof payload.client_id !== "string" ||
      typeof payload.stylist_id !== "string" ||
      typeof payload.appointment_start_time !== "string"
    ) {
      throw new ApiError(400, "Appointment management link is invalid or expired");
    }

    return {
      appointmentId: payload.appointment_id,
      clientId: payload.client_id,
      stylistId: payload.stylist_id,
      appointmentStartTime: payload.appointment_start_time
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "Appointment management link is invalid or expired");
  }
};
