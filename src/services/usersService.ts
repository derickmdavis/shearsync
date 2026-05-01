import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError, normalizeEmptyString } from "./db";

const usersPrimaryKeyConstraintName = "users_pkey";

const isUserAlreadyCreatedError = (
  error: { code?: string; message?: string; details?: string } | null
): boolean => {
  if (!error || error.code !== "23505") {
    return false;
  }

  const errorText = `${error.message ?? ""} ${error.details ?? ""}`;
  return errorText.includes(usersPrimaryKeyConstraintName) || errorText.includes("(id)");
};

const sanitizeUserProfilePayload = (payload: Row): Row => ({
  ...payload,
  location_label: normalizeEmptyString(payload.location_label as string | undefined),
  avatar_image_id: normalizeEmptyString(payload.avatar_image_id as string | undefined)
});

export const usersService = {
  async getById(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
    handleSupabaseError(error, "Unable to load user profile");
    return data;
  },

  async ensureAuthUser(userId: string, email?: string): Promise<Row | null> {
    const existing = await this.getById(userId);

    if (existing) {
      return existing;
    }

    const normalizedEmail = normalizeEmptyString(email)?.toLowerCase();
    if (!normalizedEmail) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .insert({ id: userId, email: normalizedEmail })
      .select("*")
      .single();

    if (isUserAlreadyCreatedError(error)) {
      return requireFound(await this.getById(userId), "User profile was not created");
    }

    handleSupabaseError(error, "Unable to create user profile");
    return requireFound(data, "User profile was not created");
  },

  async updateProfile(userId: string, updates: Row): Promise<Row> {
    const cleanedUpdates = sanitizeUserProfilePayload(updates);
    const { data, error } = await supabaseAdmin
      .from("users")
      .update(cleanedUpdates)
      .eq("id", userId)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to update user profile");

    if (!data) {
      throw new ApiError(404, "User profile not found");
    }

    return data;
  }
};
