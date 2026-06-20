import { randomBytes } from "crypto";
import { env } from "../config/env";
import { ApiError, requireFound } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { supabaseAdmin } from "../lib/supabase";
import { clientsService } from "./clientsService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

const REFERRAL_CODE_PREFIX = "rf_";
const REFERRAL_CODE_RANDOM_BYTES = 6;
const REFERRAL_CODE_MAX_ATTEMPTS = 5;
const REFERRAL_ATTRIBUTION_WINDOW_DAYS = 30;
const REFERRAL_BOOKING_SOURCE = "client_referral_link";

type ReferralCodeCollisionError = {
  code?: string;
  message?: string;
  details?: string;
};

type ReferralContext = {
  link: Row;
  referrerClient: Row;
  stylist: Row;
};

export type PublicReferralResolution = {
  referralLinkId: string;
  referralCode: string;
  referralUrl: string;
  stylistSlug: string;
  bookingUrl: string;
  expiresAt: string;
};

export type ReferralAttribution = {
  referralLinkId: string;
  referredByClientId: string;
  referralCodeUsed: string;
  referralAttributedAt: string;
  acquisitionSource: typeof REFERRAL_BOOKING_SOURCE;
};

export type ReferralAttributionResolution = {
  attribution: ReferralAttribution | null;
  blockedReason?: "missing_code" | "invalid_code" | "wrong_stylist" | "self_referral";
};

export type ClientReferralStats = {
  clientId: string;
  referralCode: string | null;
  referralUrl: string | null;
  totalAttributedBookings: number;
  newClientConversions: number;
  existingClientUses: number;
  recentAppointments: RowList;
};

const isUniqueViolation = (error: ReferralCodeCollisionError | null): boolean => error?.code === "23505";

const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const generateReferralCode = (): string =>
  `${REFERRAL_CODE_PREFIX}${randomBytes(REFERRAL_CODE_RANDOM_BYTES).toString("hex")}`;

const getPublicBaseUrl = (): string => {
  const baseUrl = env.WEB_APP_URL ?? env.CLIENT_APP_URL;

  if (!baseUrl) {
    throw new ApiError(500, "Referral base URL is not configured");
  }

  return baseUrl;
};

const buildReferralUrl = (referralCode: string): string =>
  new URL(`/r/${encodeURIComponent(referralCode)}`, getPublicBaseUrl()).toString();

const buildBookingUrl = (stylistSlug: string, referralCode: string): string => {
  const url = new URL(`/book/${encodeURIComponent(stylistSlug)}`, getPublicBaseUrl());
  url.searchParams.set("ref", referralCode);
  return url.toString();
};

const toPublicReferralResolution = (context: ReferralContext, now = new Date()): PublicReferralResolution => {
  const referralCode = String(context.link.referral_code ?? "");
  const referralUrl = typeof context.link.referral_url === "string" && context.link.referral_url.length > 0
    ? context.link.referral_url
    : buildReferralUrl(referralCode);
  const stylistSlug = String(context.stylist.slug ?? "");

  return {
    referralLinkId: String(context.link.id ?? ""),
    referralCode,
    referralUrl,
    stylistSlug,
    bookingUrl: buildBookingUrl(stylistSlug, referralCode),
    expiresAt: addDays(now, REFERRAL_ATTRIBUTION_WINDOW_DAYS).toISOString()
  };
};

const isSelfReferral = ({
  referrerClient,
  matchedClientId,
  guestPhone,
  guestEmail
}: {
  referrerClient: Row;
  matchedClientId?: string | null;
  guestPhone?: string | null;
  guestEmail?: string | null;
}): boolean => {
  if (matchedClientId && matchedClientId === referrerClient.id) {
    return true;
  }

  const referrerPhone = typeof referrerClient.phone_normalized === "string"
    ? referrerClient.phone_normalized
    : typeof referrerClient.phone === "string"
      ? normalizePhone(referrerClient.phone)
      : null;
  const guestPhoneNormalized = typeof guestPhone === "string" ? normalizePhone(guestPhone) : null;

  if (referrerPhone && guestPhoneNormalized && referrerPhone === guestPhoneNormalized) {
    return true;
  }

  const referrerEmail = normalizeEmail(referrerClient.email);
  const normalizedGuestEmail = normalizeEmail(guestEmail);
  return Boolean(referrerEmail && normalizedGuestEmail && referrerEmail === normalizedGuestEmail);
};

export const referralLinksService = {
  attributionWindowDays: REFERRAL_ATTRIBUTION_WINDOW_DAYS,

  buildReferralUrl,

  buildBookingUrl,

  generateReferralCode,

  async getForClient(userId: string, clientId: string): Promise<Row> {
    await clientsService.assertOwned(userId, clientId);

    const { data, error } = await supabaseAdmin
      .from("client_referral_links")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .maybeSingle();

    handleSupabaseError(error, "Unable to load client referral link");
    return requireFound(data, "Referral link not found");
  },

  async getOrCreateForClient(userId: string, clientId: string): Promise<Row> {
    await clientsService.assertOwned(userId, clientId);

    const existing = await this.getActiveLinkForClient(userId, clientId);
    if (existing) {
      return existing;
    }

    for (let attempt = 0; attempt < REFERRAL_CODE_MAX_ATTEMPTS; attempt += 1) {
      const referralCode = generateReferralCode();
      const { data, error } = await supabaseAdmin
        .from("client_referral_links")
        .insert({
          user_id: userId,
          client_id: clientId,
          referral_code: referralCode,
          referral_url: buildReferralUrl(referralCode),
          status: "active"
        })
        .select("*")
        .single();

      if (isUniqueViolation(error)) {
        continue;
      }

      handleSupabaseError(error, "Unable to create client referral link");
      return requireFound(data, "Referral link was not created");
    }

    throw new ApiError(500, "Unable to generate a unique referral code");
  },

  async getActiveLinkForClient(userId: string, clientId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("client_referral_links")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .maybeSingle();

    handleSupabaseError(error, "Unable to load client referral link");
    return (data as Row | null) ?? null;
  },

  async resolvePublicCode(referralCode: string, now = new Date()): Promise<PublicReferralResolution> {
    const context = await this.loadReferralContext(referralCode, { requireBookingEnabled: true });
    await this.recordEvent({
      eventType: "opened",
      context,
      metadata: {
        expires_at: addDays(now, REFERRAL_ATTRIBUTION_WINDOW_DAYS).toISOString()
      }
    });

    return toPublicReferralResolution(context, now);
  },

  async resolveAttributionForBooking(input: {
    stylistId: string;
    referralCode?: string | null;
    matchedClientId?: string | null;
    guestPhone?: string | null;
    guestEmail?: string | null;
    now?: Date;
  }): Promise<ReferralAttributionResolution> {
    if (!input.referralCode) {
      return { attribution: null, blockedReason: "missing_code" };
    }

    let context: ReferralContext;
    try {
      context = await this.loadReferralContext(input.referralCode, { requireBookingEnabled: false });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        return { attribution: null, blockedReason: "invalid_code" };
      }

      throw error;
    }

    if (context.link.user_id !== input.stylistId) {
      return { attribution: null, blockedReason: "wrong_stylist" };
    }

    if (isSelfReferral({
      referrerClient: context.referrerClient,
      matchedClientId: input.matchedClientId,
      guestPhone: input.guestPhone,
      guestEmail: input.guestEmail
    })) {
      await this.recordEvent({
        eventType: "self_referral_blocked",
        context,
        metadata: {
          matched_client_id: input.matchedClientId ?? null
        }
      });
      return { attribution: null, blockedReason: "self_referral" };
    }

    return {
      attribution: {
        referralLinkId: String(context.link.id ?? ""),
        referredByClientId: String(context.referrerClient.id ?? ""),
        referralCodeUsed: String(context.link.referral_code ?? ""),
        referralAttributedAt: (input.now ?? new Date()).toISOString(),
        acquisitionSource: REFERRAL_BOOKING_SOURCE
      }
    };
  },

  async getClientReferralStats(userId: string, clientId: string): Promise<ClientReferralStats> {
    await clientsService.assertOwned(userId, clientId);
    const link = await this.getActiveLinkForClient(userId, clientId);
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, appointment_date, service_name, status, referral_attributed_at")
      .eq("user_id", userId)
      .eq("referred_by_client_id", clientId)
      .order("referral_attributed_at", { ascending: false });

    handleSupabaseError(error, "Unable to load client referral stats");
    const appointments = (data ?? []) as RowList;
    const referredClientIds = new Set(
      appointments
        .map((appointment) => appointment.client_id)
        .filter((appointmentClientId): appointmentClientId is string => typeof appointmentClientId === "string")
    );

    return {
      clientId,
      referralCode: typeof link?.referral_code === "string" ? link.referral_code : null,
      referralUrl: typeof link?.referral_url === "string" ? link.referral_url : null,
      totalAttributedBookings: appointments.length,
      newClientConversions: Array.from(referredClientIds).filter((appointmentClientId) => appointmentClientId !== clientId).length,
      existingClientUses: appointments.filter((appointment) => appointment.client_id === clientId).length,
      recentAppointments: appointments.slice(0, 10)
    };
  },

  async recordBookingAttributed(referralCode: string, appointmentId: string, metadata: Row = {}): Promise<void> {
    const context = await this.loadReferralContext(referralCode, { requireBookingEnabled: false });

    await this.recordEvent({
      eventType: "booking_attributed",
      context,
      appointmentId,
      metadata
    });
  },

  async loadReferralContext(
    referralCode: string,
    options: { requireBookingEnabled?: boolean } = {}
  ): Promise<ReferralContext> {
    const { data: link, error: linkError } = await supabaseAdmin
      .from("client_referral_links")
      .select("*")
      .eq("referral_code", referralCode)
      .eq("status", "active")
      .maybeSingle();

    handleSupabaseError(linkError, "Unable to load referral link");
    const activeLink = requireFound(link, "Referral link not found");

    const [clientResult, stylistResult] = await Promise.all([
      supabaseAdmin
        .from("clients")
        .select("*")
        .eq("id", activeLink.client_id)
        .eq("user_id", activeLink.user_id)
        .is("deleted_at", null)
        .maybeSingle(),
      supabaseAdmin
        .from("stylists")
        .select("*")
        .eq("user_id", activeLink.user_id)
        .maybeSingle()
    ]);

    handleSupabaseError(clientResult.error, "Unable to load referral client");
    handleSupabaseError(stylistResult.error, "Unable to load referral stylist");

    const referrerClient = requireFound(clientResult.data, "Referral link not found");
    const stylist = requireFound(stylistResult.data, "Referral stylist not found");

    if (options.requireBookingEnabled && stylist.booking_enabled !== true) {
      throw new ApiError(409, "Online booking is not enabled for this stylist");
    }

    return {
      link: activeLink,
      referrerClient,
      stylist
    };
  },

  async recordEvent(input: {
    eventType: "opened" | "booking_attributed" | "self_referral_blocked" | "expired_attribution";
    context: ReferralContext;
    appointmentId?: string | null;
    metadata?: Row;
  }): Promise<void> {
    const { error } = await supabaseAdmin
      .from("referral_events")
      .insert({
        referral_link_id: input.context.link.id,
        user_id: input.context.link.user_id,
        referred_by_client_id: input.context.referrerClient.id,
        appointment_id: input.appointmentId ?? null,
        event_type: input.eventType,
        metadata: input.metadata ?? {}
      });

    handleSupabaseError(error, "Unable to record referral event");
  }
};
