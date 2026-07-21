import { randomBytes } from "crypto";
import { env } from "../config/env";
import { ApiError, requireFound } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { supabaseAdmin } from "../lib/supabase";
import { getCurrentLocalDate, getStartOfLocalDayUtc } from "../lib/timezone";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { recordProductTelemetry } from "./productTelemetry";

const REFERRAL_CODE_PREFIX = "rf_";
const REFERRAL_CODE_RANDOM_BYTES = 6;
const REFERRAL_CODE_MAX_ATTEMPTS = 5;
const REFERRAL_ATTRIBUTION_WINDOW_DAYS = 30;
const REFERRAL_BOOKING_SOURCE = "client_referral_link";

export type ReferralSource =
  | "thank_you_email"
  | "email_campaign"
  | "direct_share"
  | "manual"
  | "client_share"
  | "unknown";

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

export type ActivityReferralStatsRange = "this_month";
export type InsightsReferralStatsRange = "this_month" | "all_time";

export type ActivityReferralStats = {
  hasReferralData: boolean;
  range: ActivityReferralStatsRange;
  newClientsFromReferrals: number;
  appointmentsBookedFromReferrals: number;
  revenueFromReferrals: number;
  bookedValueFromReferrals: number;
  referralConversionRate: number;
  linksSent: number;
  linksClicked: number;
  topReferrer: {
    clientId: string;
    displayName: string;
    referralCount: number;
  } | null;
};

export type InsightsReferralStats = {
  period: {
    label: "This Month" | "All Time";
    startAt: string;
    endAt: string;
  };
  newClients: number;
  appointmentsBooked: number;
  conversionRatePercent: number | null;
  linksSent: number;
  linksClicked: number;
  attributedRevenueMinor: number;
  bookedValueMinor: number;
  currency: "USD";
  historicalResults: {
    newClients: number;
    appointmentsBooked: number;
    hasSuccessfulConversions: boolean;
  };
  topReferrer: {
    clientId: string;
    displayName: string;
    referralCount: number;
  } | null;
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

const addMonthsToDateText = (dateText: string, monthsToAdd: number): string => {
  const [yearText, monthText] = dateText.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1 + monthsToAdd;
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

const getThisMonthRange = async (userId: string): Promise<{ startIso: string; endIso: string }> => {
  const timeZone = await businessTimeZoneService.getForUser(userId);
  const today = getCurrentLocalDate(timeZone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextMonthStart = addMonthsToDateText(monthStart, 1);

  return {
    startIso: getStartOfLocalDayUtc(monthStart, timeZone).toISOString(),
    endIso: getStartOfLocalDayUtc(nextMonthStart, timeZone).toISOString()
  };
};

const getInsightsReferralRange = (
  range: InsightsReferralStatsRange,
  timeZone: string,
  now: Date
): { label: "This Month" | "All Time"; startIso: string; endIso: string } => {
  if (range === "all_time") {
    return {
      label: "All Time",
      // Explicit lower bound makes the all-time window transportable and avoids
      // a client having to infer a missing start timestamp.
      startIso: "1970-01-01T00:00:00.000Z",
      endIso: now.toISOString()
    };
  }

  const today = getCurrentLocalDate(timeZone, now);
  const monthStart = `${today.slice(0, 7)}-01`;
  return {
    label: "This Month",
    startIso: getStartOfLocalDayUtc(monthStart, timeZone).toISOString(),
    endIso: now.toISOString()
  };
};

const toNumber = (value: unknown): number => {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const roundRate = (value: number): number => Math.round(value * 10_000) / 10_000;

const getClientDisplayName = (client: Row | null | undefined): string => {
  const preferredName = typeof client?.preferred_name === "string" ? client.preferred_name.trim() : "";
  if (preferredName) {
    return preferredName;
  }

  const firstName = typeof client?.first_name === "string" ? client.first_name.trim() : "";
  const lastName = typeof client?.last_name === "string" ? client.last_name.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return fullName || "Client";
};

const getTopReferrerId = (rows: RowList, referralColumn: string): { clientId: string; referralCount: number } | null => {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const clientId = row[referralColumn];
    if (typeof clientId !== "string" || clientId.length === 0) {
      continue;
    }

    counts.set(clientId, (counts.get(clientId) ?? 0) + 1);
  }

  let topReferrer: { clientId: string; referralCount: number } | null = null;
  for (const [clientId, referralCount] of counts) {
    if (!topReferrer || referralCount > topReferrer.referralCount) {
      topReferrer = { clientId, referralCount };
    }
  }

  return topReferrer;
};

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

  async getOrCreateForClient(
    userId: string,
    clientId: string,
    options: { source?: ReferralSource | null } = {}
  ): Promise<Row> {
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
          status: "active",
          source: options.source ?? "client_share"
        })
        .select("*")
        .single();

      if (isUniqueViolation(error)) {
        continue;
      }

      handleSupabaseError(error, "Unable to create client referral link");
      const link = requireFound(data, "Referral link was not created");
      await recordProductTelemetry({
        accountUserId: userId,
        actorUserId: userId,
        clientId,
        eventType: "referral_link_created",
        eventSource: "backend",
        dedupeKey: typeof link.id === "string" ? `referral_link_created:${link.id}` : null,
        metadata: {
          referral_link_id: link.id ?? null,
          source: options.source ?? "client_share"
        }
      });
      return link;
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

  async resolvePublicCode(
    referralCode: string,
    now = new Date(),
    options: { source?: ReferralSource | null } = {}
  ): Promise<PublicReferralResolution> {
    const context = await this.loadReferralContext(referralCode, { requireBookingEnabled: true });
    await this.recordEvent({
      eventType: "opened",
      context,
      source: options.source ?? "unknown",
      metadata: {
        source: options.source ?? "unknown",
        expires_at: addDays(now, REFERRAL_ATTRIBUTION_WINDOW_DAYS).toISOString()
      }
    });
    await recordProductTelemetry({
      accountUserId: typeof context.link.user_id === "string" ? context.link.user_id : null,
      clientId: typeof context.referrerClient.id === "string" ? context.referrerClient.id : null,
      eventType: "referral_link_clicked",
      eventSource: "public_booking",
      stylistSlug: typeof context.stylist.slug === "string" ? context.stylist.slug : null,
      metadata: {
        referral_link_id: context.link.id ?? null,
        stylist_slug: context.stylist.slug ?? null,
        source: options.source ?? "unknown"
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

  async getActivityReferralStats(
    userId: string,
    options: { range?: ActivityReferralStatsRange } = {}
  ): Promise<ActivityReferralStats> {
    const range = options.range ?? "this_month";
    const { startIso, endIso } = await getThisMonthRange(userId);

    const [linksResult, clicksResult, clientsResult, appointmentsResult] = await Promise.all([
      supabaseAdmin
        .from("client_referral_links")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", startIso)
        .lt("created_at", endIso),
      supabaseAdmin
        .from("referral_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("event_type", "opened")
        .gte("created_at", startIso)
        .lt("created_at", endIso),
      supabaseAdmin
        .from("clients")
        .select("id, original_referred_by_client_id, original_referral_attributed_at")
        .eq("user_id", userId)
        .not("original_referral_attributed_at", "is", null)
        .gte("original_referral_attributed_at", startIso)
        .lt("original_referral_attributed_at", endIso),
      supabaseAdmin
        .from("appointments")
        .select("id, client_id, referred_by_client_id, referral_link_id, referral_attributed_at, status, price")
        .eq("user_id", userId)
        .not("referral_attributed_at", "is", null)
        .neq("status", "cancelled")
        .gte("referral_attributed_at", startIso)
        .lt("referral_attributed_at", endIso)
    ]);

    handleSupabaseError(linksResult.error, "Unable to load referral links sent");
    handleSupabaseError(clicksResult.error, "Unable to load referral link clicks");
    handleSupabaseError(clientsResult.error, "Unable to load referred clients");
    handleSupabaseError(appointmentsResult.error, "Unable to load referred appointments");

    const referredClients = (clientsResult.data ?? []) as RowList;
    const referredAppointments = (appointmentsResult.data ?? []) as RowList;
    const completedAppointments = referredAppointments.filter((appointment) => appointment.status === "completed");
    const linksSent = linksResult.count ?? 0;
    const linksClicked = clicksResult.count ?? 0;
    const appointmentsBookedFromReferrals = referredAppointments.length;
    const bookedValueFromReferrals = referredAppointments.reduce(
      (total, appointment) => total + toNumber(appointment.price),
      0
    );
    const revenueFromReferrals = completedAppointments.reduce(
      (total, appointment) => total + toNumber(appointment.price),
      0
    );
    const fallbackTopReferrer = getTopReferrerId(referredClients, "original_referred_by_client_id");
    const topReferrerCandidate = getTopReferrerId(referredAppointments, "referred_by_client_id") ?? fallbackTopReferrer;
    let topReferrer: ActivityReferralStats["topReferrer"] = null;

    if (topReferrerCandidate) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("id, first_name, last_name, preferred_name")
        .eq("user_id", userId)
        .eq("id", topReferrerCandidate.clientId)
        .maybeSingle();

      handleSupabaseError(error, "Unable to load top referral client");

      topReferrer = {
        clientId: topReferrerCandidate.clientId,
        displayName: getClientDisplayName((data as Row | null) ?? null),
        referralCount: topReferrerCandidate.referralCount
      };
    }

    return {
      hasReferralData: Boolean(
        linksSent
        || linksClicked
        || referredClients.length
        || appointmentsBookedFromReferrals
        || revenueFromReferrals
        || bookedValueFromReferrals
        || topReferrer
      ),
      range,
      newClientsFromReferrals: referredClients.length,
      appointmentsBookedFromReferrals,
      revenueFromReferrals,
      bookedValueFromReferrals,
      referralConversionRate: linksClicked > 0
        ? roundRate(appointmentsBookedFromReferrals / linksClicked)
        : 0,
      linksSent,
      linksClicked,
      topReferrer
    };
  },

  async getInsightsReferralStats(
    userId: string,
    options: { range: InsightsReferralStatsRange; timeZone: string; now?: Date }
  ): Promise<InsightsReferralStats> {
    const period = getInsightsReferralRange(options.range, options.timeZone, options.now ?? new Date());

    const [linksResult, clicksResult, clientsResult, appointmentsResult, lifetimeClientsResult, lifetimeAppointmentsResult] = await Promise.all([
      supabaseAdmin
        .from("client_referral_links")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", period.startIso)
        .lt("created_at", period.endIso),
      supabaseAdmin
        .from("referral_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("event_type", "opened")
        .gte("created_at", period.startIso)
        .lt("created_at", period.endIso),
      supabaseAdmin
        .from("clients")
        .select("id, original_referred_by_client_id, original_referral_attributed_at")
        .eq("user_id", userId)
        .not("original_referral_attributed_at", "is", null)
        .gte("original_referral_attributed_at", period.startIso)
        .lt("original_referral_attributed_at", period.endIso),
      supabaseAdmin
        .from("appointments")
        .select("id, client_id, referred_by_client_id, referral_link_id, referral_attributed_at, status, price")
        .eq("user_id", userId)
        .not("referral_attributed_at", "is", null)
        .neq("status", "cancelled")
        .gte("referral_attributed_at", period.startIso)
        .lt("referral_attributed_at", period.endIso),
      supabaseAdmin
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("original_referral_attributed_at", "is", null),
      supabaseAdmin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .not("referral_attributed_at", "is", null)
        .neq("status", "cancelled")
    ]);

    handleSupabaseError(linksResult.error, "Unable to load Insights referral links sent");
    handleSupabaseError(clicksResult.error, "Unable to load Insights referral link clicks");
    handleSupabaseError(clientsResult.error, "Unable to load Insights referred clients");
    handleSupabaseError(appointmentsResult.error, "Unable to load Insights referred appointments");
    handleSupabaseError(lifetimeClientsResult.error, "Unable to load lifetime referred clients");
    handleSupabaseError(lifetimeAppointmentsResult.error, "Unable to load lifetime referred appointments");

    const referredClients = (clientsResult.data ?? []) as RowList;
    const referredAppointments = (appointmentsResult.data ?? []) as RowList;
    const completedAppointments = referredAppointments.filter((appointment) => appointment.status === "completed");
    const linksSent = linksResult.count ?? 0;
    const linksClicked = clicksResult.count ?? 0;
    const appointmentsBooked = referredAppointments.length;
    const lifetimeNewClients = lifetimeClientsResult.count ?? 0;
    const lifetimeAppointmentsBooked = lifetimeAppointmentsResult.count ?? 0;
    const bookedValueMinor = Math.round(referredAppointments.reduce(
      (total, appointment) => total + toNumber(appointment.price),
      0
    ) * 100);
    const attributedRevenueMinor = Math.round(completedAppointments.reduce(
      (total, appointment) => total + toNumber(appointment.price),
      0
    ) * 100);
    const fallbackTopReferrer = getTopReferrerId(referredClients, "original_referred_by_client_id");
    const topReferrerCandidate = getTopReferrerId(referredAppointments, "referred_by_client_id") ?? fallbackTopReferrer;
    let topReferrer: InsightsReferralStats["topReferrer"] = null;

    if (topReferrerCandidate) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("id, first_name, last_name, preferred_name")
        .eq("user_id", userId)
        .eq("id", topReferrerCandidate.clientId)
        .maybeSingle();
      handleSupabaseError(error, "Unable to load Insights top referral client");

      // Do not expose an ID that cannot be proven to belong to this account.
      if (data) {
        topReferrer = {
          clientId: topReferrerCandidate.clientId,
          displayName: getClientDisplayName(data as Row),
          referralCount: topReferrerCandidate.referralCount
        };
      }
    }

    return {
      period: { label: period.label, startAt: period.startIso, endAt: period.endIso },
      newClients: referredClients.length,
      appointmentsBooked,
      conversionRatePercent: linksClicked > 0 ? roundRate((appointmentsBooked / linksClicked) * 100) : null,
      linksSent,
      linksClicked,
      attributedRevenueMinor,
      bookedValueMinor,
      currency: "USD",
      historicalResults: {
        newClients: lifetimeNewClients,
        appointmentsBooked: lifetimeAppointmentsBooked,
        hasSuccessfulConversions: lifetimeNewClients > 0 || lifetimeAppointmentsBooked > 0
      },
      topReferrer
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
    await recordProductTelemetry({
      accountUserId: typeof context.link.user_id === "string" ? context.link.user_id : null,
      clientId: typeof context.referrerClient.id === "string" ? context.referrerClient.id : null,
      appointmentId,
      eventType: "referral_booking_submitted",
      eventSource: "public_booking",
      stylistSlug: typeof context.stylist.slug === "string" ? context.stylist.slug : null,
      metadata: {
        referral_link_id: context.link.id ?? null,
        is_existing_client: metadata.is_existing_client ?? null
      }
    });
  },

  async recordAppointmentCompleted(appointment: Row): Promise<void> {
    const referralLinkId = typeof appointment.referral_link_id === "string" ? appointment.referral_link_id : null;
    const userId = typeof appointment.user_id === "string" ? appointment.user_id : null;
    const referredByClientId = typeof appointment.referred_by_client_id === "string"
      ? appointment.referred_by_client_id
      : null;

    if (!referralLinkId || !userId || !referredByClientId) {
      return;
    }

    const { error } = await supabaseAdmin
      .from("referral_events")
      .insert({
        referral_link_id: referralLinkId,
        user_id: userId,
        referred_by_client_id: referredByClientId,
        referred_client_id: typeof appointment.client_id === "string" ? appointment.client_id : null,
        appointment_id: typeof appointment.id === "string" ? appointment.id : null,
        event_type: "appointment_completed",
        source: typeof appointment.acquisition_source === "string" ? appointment.acquisition_source : null,
        metadata: {
          status: appointment.status ?? null,
          price: appointment.price ?? null,
          referral_code_used: appointment.referral_code_used ?? null
        }
      });

    handleSupabaseError(error, "Unable to record referral completion event");
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
    source?: string | null;
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
        source: input.source ?? null,
        metadata: input.metadata ?? {}
      });

    handleSupabaseError(error, "Unable to record referral event");
  }
};
