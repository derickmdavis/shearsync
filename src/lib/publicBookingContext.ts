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
  campaign_attribution?: {
    campaign_id: string;
    campaign_run_id: string;
    campaign_recipient_id: string;
    expires_at: string;
  };
}

export interface PublicBookingContext {
  stylistSlug: string;
  isExistingClient: boolean;
  campaignAttribution?: {
    campaignId: string;
    campaignRunId: string;
    campaignRecipientId: string;
    expiresAt: string;
  };
}

const getPublicBookingContextSecret = (): string => env.SUPABASE_JWT_SECRET ?? env.SUPABASE_SERVICE_ROLE_KEY;

export const createPublicBookingContextToken = (context: PublicBookingContext): string => {
  const campaignExpiresAt = context.campaignAttribution ? new Date(context.campaignAttribution.expiresAt) : null;
  const expiresIn = campaignExpiresAt
    ? Math.max(1, Math.floor((campaignExpiresAt.getTime() - Date.now()) / 1000))
    : PUBLIC_BOOKING_CONTEXT_TTL_SECONDS;
  return jwt.sign(
    {
      typ: PUBLIC_BOOKING_CONTEXT_TYPE,
      stylist_slug: context.stylistSlug,
      is_existing_client: context.isExistingClient,
      ...(context.campaignAttribution ? {
        campaign_attribution: {
          campaign_id: context.campaignAttribution.campaignId,
          campaign_run_id: context.campaignAttribution.campaignRunId,
          campaign_recipient_id: context.campaignAttribution.campaignRecipientId,
          expires_at: context.campaignAttribution.expiresAt
        }
      } : {})
    },
    getPublicBookingContextSecret(),
    {
      algorithm: "HS256",
      audience: PUBLIC_BOOKING_CONTEXT_AUDIENCE,
      issuer: PUBLIC_BOOKING_CONTEXT_ISSUER,
      expiresIn
    }
  );
};

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

    const campaign = payload.campaign_attribution;
    if (campaign && (
      typeof campaign.campaign_id !== "string"
      || typeof campaign.campaign_run_id !== "string"
      || typeof campaign.campaign_recipient_id !== "string"
      || typeof campaign.expires_at !== "string"
      || new Date(campaign.expires_at).getTime() < Date.now()
    )) {
      throw new ApiError(400, "Booking context is invalid or expired");
    }

    return {
      stylistSlug: payload.stylist_slug,
      isExistingClient: payload.is_existing_client,
      ...(campaign ? {
        campaignAttribution: {
          campaignId: campaign.campaign_id,
          campaignRunId: campaign.campaign_run_id,
          campaignRecipientId: campaign.campaign_recipient_id,
          expiresAt: campaign.expires_at
        }
      } : {})
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "Booking context is invalid or expired");
  }
};
