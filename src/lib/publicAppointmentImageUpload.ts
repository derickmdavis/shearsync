import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "./errors";

const PUBLIC_APPOINTMENT_IMAGE_UPLOAD_ISSUER = "shearsync-public-booking";
const PUBLIC_APPOINTMENT_IMAGE_UPLOAD_AUDIENCE = "public-appointment-image-upload";
const PUBLIC_APPOINTMENT_IMAGE_UPLOAD_TYPE = "public_appointment_image_upload";
const PUBLIC_APPOINTMENT_IMAGE_UPLOAD_PURPOSE = "appointment_reference_photo";

interface PublicAppointmentImageUploadClaims extends jwt.JwtPayload {
  typ: typeof PUBLIC_APPOINTMENT_IMAGE_UPLOAD_TYPE;
  purpose: typeof PUBLIC_APPOINTMENT_IMAGE_UPLOAD_PURPOSE;
  appointment_id: string;
  client_id: string;
  stylist_id: string;
  appointment_start_time: string;
  jti: string;
}

export interface PublicAppointmentImageUploadContext {
  appointmentId: string;
  clientId: string;
  stylistId: string;
  appointmentStartTime: string;
  tokenId?: string;
}

export interface ResolvedPublicAppointmentImageUploadContext extends PublicAppointmentImageUploadContext {
  tokenId: string;
}

const getPublicAppointmentImageUploadSecret = (): string => env.SUPABASE_JWT_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

export const getPublicAppointmentImageUploadExpiresAt = (appointmentStartTime: string): string => {
  const timestamp = new Date(appointmentStartTime).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new ApiError(400, "Appointment start time is invalid");
  }

  return new Date(timestamp).toISOString();
};

const getAppointmentStartExpiration = (appointmentStartTime: string): number =>
  Math.floor(new Date(getPublicAppointmentImageUploadExpiresAt(appointmentStartTime)).getTime() / 1000);

export const createPublicAppointmentImageUploadToken = (
  context: PublicAppointmentImageUploadContext
): string =>
  jwt.sign(
    {
      typ: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_TYPE,
      purpose: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_PURPOSE,
      appointment_id: context.appointmentId,
      client_id: context.clientId,
      stylist_id: context.stylistId,
      appointment_start_time: context.appointmentStartTime,
      jti: context.tokenId ?? randomUUID(),
      exp: getAppointmentStartExpiration(context.appointmentStartTime)
    },
    getPublicAppointmentImageUploadSecret(),
    {
      algorithm: "HS256",
      audience: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_AUDIENCE,
      issuer: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_ISSUER
    }
  );

export const resolvePublicAppointmentImageUploadToken = (
  token: string | undefined
): ResolvedPublicAppointmentImageUploadContext => {
  if (!token) {
    throw new ApiError(400, "Reference photo upload token is invalid or expired");
  }

  try {
    const payload = jwt.verify(token, getPublicAppointmentImageUploadSecret(), {
      algorithms: ["HS256"],
      audience: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_AUDIENCE,
      issuer: PUBLIC_APPOINTMENT_IMAGE_UPLOAD_ISSUER
    }) as PublicAppointmentImageUploadClaims;

    if (
      payload.typ !== PUBLIC_APPOINTMENT_IMAGE_UPLOAD_TYPE ||
      payload.purpose !== PUBLIC_APPOINTMENT_IMAGE_UPLOAD_PURPOSE ||
      typeof payload.appointment_id !== "string" ||
      typeof payload.client_id !== "string" ||
      typeof payload.stylist_id !== "string" ||
      typeof payload.appointment_start_time !== "string" ||
      typeof payload.jti !== "string"
    ) {
      throw new ApiError(400, "Reference photo upload token is invalid or expired");
    }

    return {
      appointmentId: payload.appointment_id,
      clientId: payload.client_id,
      stylistId: payload.stylist_id,
      appointmentStartTime: payload.appointment_start_time,
      tokenId: payload.jti
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "Reference photo upload token is invalid or expired");
  }
};
