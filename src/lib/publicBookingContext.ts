import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ApiError } from "./errors";

const PUBLIC_BOOKING_CONTEXT_ISSUER = "shearsync-public-booking";
const PUBLIC_BOOKING_CONTEXT_AUDIENCE = "public-booking-context";
const PUBLIC_BOOKING_CONTEXT_TYPE = "public_booking_context";
const PUBLIC_BOOKING_CONTEXT_TTL_SECONDS = 30 * 60;

interface PublicBookingContextClaims extends jwt.JwtPayload {
  typ: typeof PUBLIC_BOOKING_CONTEXT_TYPE;
  stylist_slug: string;
  is_existing_client: boolean;
}

export interface PublicBookingContext {
  stylistSlug: string;
  isExistingClient: boolean;
}

const getPublicBookingContextSecret = (): string => env.SUPABASE_JWT_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

export const createPublicBookingContextToken = (context: PublicBookingContext): string =>
  jwt.sign(
    {
      typ: PUBLIC_BOOKING_CONTEXT_TYPE,
      stylist_slug: context.stylistSlug,
      is_existing_client: context.isExistingClient
    },
    getPublicBookingContextSecret(),
    {
      algorithm: "HS256",
      audience: PUBLIC_BOOKING_CONTEXT_AUDIENCE,
      issuer: PUBLIC_BOOKING_CONTEXT_ISSUER,
      expiresIn: PUBLIC_BOOKING_CONTEXT_TTL_SECONDS
    }
  );

export const resolvePublicBookingContextToken = (
  token: string | undefined,
  expectedStylistSlug: string
): PublicBookingContext | null => {
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, getPublicBookingContextSecret(), {
      algorithms: ["HS256"],
      audience: PUBLIC_BOOKING_CONTEXT_AUDIENCE,
      issuer: PUBLIC_BOOKING_CONTEXT_ISSUER
    }) as PublicBookingContextClaims;

    if (payload.typ !== PUBLIC_BOOKING_CONTEXT_TYPE || payload.stylist_slug !== expectedStylistSlug) {
      throw new ApiError(400, "Booking context is invalid or expired");
    }

    return {
      stylistSlug: payload.stylist_slug,
      isExistingClient: payload.is_existing_client
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "Booking context is invalid or expired");
  }
};
