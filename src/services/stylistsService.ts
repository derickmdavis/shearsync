import { requireFound } from "../lib/errors";
import { resolveBusinessTimeZone } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { PublicStylistProfile } from "../types/api";
import type { Row } from "./db";
import { ApiError } from "../lib/errors";
import { handleSupabaseError, normalizeEmptyString } from "./db";
import { entitlementsService } from "./entitlementsService";
import { usersService } from "./usersService";

const sanitizeStylistPayload = (payload: Row): Row => ({
  ...payload,
  display_name: normalizeEmptyString(payload.display_name as string | undefined),
  bio: normalizeEmptyString(payload.bio as string | undefined),
  cover_photo_url: normalizeEmptyString(payload.cover_photo_url as string | undefined)
});

const stylistsSlugConstraintName = "stylists_slug_key";

const isSlugAlreadyTakenError = (
  error: { code?: string; message?: string; details?: string } | null
): boolean => {
  if (!error || error.code !== "23505") {
    return false;
  }

  const errorText = `${error.message ?? ""} ${error.details ?? ""}`;
  return errorText.includes(stylistsSlugConstraintName) || errorText.includes("(slug)");
};

const toWords = (value: string): string =>
  value
    .trim()
    .replace(/[._+-]+/g, " ")
    .replace(/\s+/g, " ");

const toDisplayName = (user: Row, payload: Row): string => {
  const explicitDisplayName = normalizeEmptyString(payload.display_name as string | undefined);
  if (explicitDisplayName) {
    return explicitDisplayName;
  }

  const businessName = normalizeEmptyString(user.business_name as string | undefined);
  if (businessName) {
    return businessName;
  }

  const fullName = normalizeEmptyString(user.full_name as string | undefined);
  if (fullName) {
    return fullName;
  }

  const email = normalizeEmptyString(user.email as string | undefined);
  if (email) {
    return toWords(email.split("@")[0] ?? email);
  }

  return "My Booking Page";
};

const toSlugToken = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const buildDefaultSlug = (user: Row, payload: Row, displayName: string): string => {
  const explicitSlug = normalizeEmptyString(payload.slug as string | undefined);
  if (explicitSlug) {
    return explicitSlug;
  }

  const preferredSource =
    normalizeEmptyString(payload.display_name as string | undefined)
    ?? normalizeEmptyString(user.business_name as string | undefined)
    ?? normalizeEmptyString(user.full_name as string | undefined)
    ?? normalizeEmptyString(user.email as string | undefined)
    ?? displayName;

  return toSlugToken(preferredSource || "stylist") || "stylist";
};

const findAvailableSlug = async (baseSlug: string): Promise<string> => {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
    const { data, error } = await supabaseAdmin
      .from("stylists")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();

    handleSupabaseError(error, "Unable to validate booking slug");
    if (!data) {
      return candidate;
    }
  }

  throw new ApiError(500, "Unable to generate a booking slug");
};

const createDefaultStylistForUser = async (userId: string, payload: Row): Promise<Row> => {
  const user = requireFound(await usersService.getById(userId), "User profile not found");
  const displayName = toDisplayName(user, payload);
  const defaultSlug = buildDefaultSlug(user, payload, displayName);
  const slug = await findAvailableSlug(defaultSlug);
  const insertPayload = {
    user_id: userId,
    slug,
    display_name: displayName,
    bio: payload.bio,
    cover_photo_url: payload.cover_photo_url,
    booking_enabled: payload.booking_enabled ?? false
  };

  const { data, error } = await supabaseAdmin
    .from("stylists")
    .insert(insertPayload)
    .select("*")
    .single();

  if (isSlugAlreadyTakenError(error)) {
    const retrySlug = await findAvailableSlug(defaultSlug);
    const retryResult = await supabaseAdmin
      .from("stylists")
      .insert({ ...insertPayload, slug: retrySlug })
      .select("*")
      .single();

    handleSupabaseError(retryResult.error, "Unable to create booking settings");
    return requireFound(retryResult.data, "Booking settings were not created");
  }

  handleSupabaseError(error, "Unable to create booking settings");
  return requireFound(data, "Booking settings were not created");
};

export const stylistsService = {
  async getBySlug(slug: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("stylists")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load stylist");
    return requireFound(data, "Stylist not found");
  },

  async getByUserId(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("stylists")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load booking settings");
    return data;
  },

  async ensureByUserId(userId: string): Promise<Row> {
    const existing = await this.getByUserId(userId);

    if (existing) {
      return existing;
    }

    return createDefaultStylistForUser(userId, {});
  },

  async getPublicProfileBySlug(slug: string): Promise<PublicStylistProfile> {
    const stylist = await this.getBySlug(slug);
    const user = await usersService.getById(stylist.user_id as string);

    return {
      id: stylist.id as string,
      slug: stylist.slug as string,
      display_name: (stylist.display_name as string) ?? "",
      bio: (stylist.bio as string | null | undefined) ?? null,
      cover_photo_url: (stylist.cover_photo_url as string | null | undefined) ?? null,
      booking_enabled: Boolean(stylist.booking_enabled),
      business_name: (user?.business_name as string | null | undefined) ?? null,
      phone_number: (user?.phone_number as string | null | undefined) ?? null,
      timezone: resolveBusinessTimeZone(user)
    };
  },

  assertPublicBookingEnabled(stylist: Row): void {
    if (!stylist.booking_enabled) {
      throw new ApiError(400, "Online booking is not enabled for this stylist");
    }
  },

  async upsertForUser(userId: string, payload: Row): Promise<Row> {
    const existing = await this.getByUserId(userId);
    const cleanedPayload = sanitizeStylistPayload(payload);

    if (payload.cover_photo_url !== undefined) {
      await entitlementsService.assertFeatureAllowed(userId, "customCoverPhoto");
    }

    if (
      payload.slug !== undefined
      && payload.slug !== existing?.slug
    ) {
      if (existing) {
        await entitlementsService.assertFeatureAllowed(userId, "customSlug");
      } else {
        const user = requireFound(await usersService.getById(userId), "User profile not found");
        const defaultSlug = buildDefaultSlug(user, cleanedPayload, toDisplayName(user, cleanedPayload));

        if (cleanedPayload.slug !== defaultSlug) {
          await entitlementsService.assertFeatureAllowed(userId, "customSlug");
        }
      }
    }

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("stylists")
        .update(cleanedPayload)
        .eq("user_id", userId)
        .select("*")
        .single();

      if (isSlugAlreadyTakenError(error)) {
        throw new ApiError(409, "Booking slug is already in use");
      }

      handleSupabaseError(error, "Unable to update booking settings");
      return requireFound(data, "Booking settings were not updated");
    }

    return createDefaultStylistForUser(userId, cleanedPayload);
  }
};
