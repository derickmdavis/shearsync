import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { CreateEarlyAccessRequestInput } from "../validators/earlyAccessValidators";
import type { Row } from "./db";

interface EarlyAccessRequestRow extends Row {
  id: string;
  email: string;
}

const EARLY_ACCESS_SUCCESS = {
  success: true,
  message: "You're on the list."
} as const;

const EARLY_ACCESS_ERROR_MESSAGE = "Unable to join the waitlist right now. Please try again.";

const escapePostgrestFilterValue = (value: string): string => value.replace(/([(),])/g, "\\$1");

const findByEmail = async (email: string): Promise<EarlyAccessRequestRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("early_access_requests")
    .select("id, email")
    .or(`email.eq.${escapePostgrestFilterValue(email)},email.ilike.${escapePostgrestFilterValue(email)}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, EARLY_ACCESS_ERROR_MESSAGE);
  }

  return (data as EarlyAccessRequestRow | null) ?? null;
};

const toDatabasePayload = (input: CreateEarlyAccessRequestInput) => ({
  full_name: input.full_name,
  email: input.email,
  phone: input.phone ?? null,
  status: "new",
  source: input.source ?? "homepage_waitlist",
  utm_source: input.utm_source ?? null,
  utm_medium: input.utm_medium ?? null,
  utm_campaign: input.utm_campaign ?? null,
  notes: input.notes ?? null
});

const toDatabaseUpdatePayload = (input: CreateEarlyAccessRequestInput) => {
  const payload: Record<string, string | null> = {
    full_name: input.full_name,
    email: input.email
  };

  if (input.phone !== undefined) {
    payload.phone = input.phone;
  }

  if (input.source !== undefined) {
    payload.source = input.source;
  }

  if (input.utm_source !== undefined) {
    payload.utm_source = input.utm_source;
  }

  if (input.utm_medium !== undefined) {
    payload.utm_medium = input.utm_medium;
  }

  if (input.utm_campaign !== undefined) {
    payload.utm_campaign = input.utm_campaign;
  }

  if (input.notes !== undefined) {
    payload.notes = input.notes;
  }

  return payload;
};

export const earlyAccessService = {
  async create(input: CreateEarlyAccessRequestInput): Promise<typeof EARLY_ACCESS_SUCCESS> {
    const existing = await findByEmail(input.email);
    const payload = toDatabasePayload(input);

    if (existing) {
      const { error } = await supabaseAdmin
        .from("early_access_requests")
        .update({
          ...toDatabaseUpdatePayload(input),
          updated_at: new Date().toISOString()
        })
        .eq("id", existing.id);

      if (error) {
        throw new ApiError(500, EARLY_ACCESS_ERROR_MESSAGE);
      }

      return EARLY_ACCESS_SUCCESS;
    }

    const { error } = await supabaseAdmin
      .from("early_access_requests")
      .insert(payload);

    if (error) {
      if (error.code === "23505") {
        const duplicate = await findByEmail(input.email);
        if (duplicate) {
          const { error: updateError } = await supabaseAdmin
            .from("early_access_requests")
            .update({
              ...toDatabaseUpdatePayload(input),
              updated_at: new Date().toISOString()
            })
            .eq("id", duplicate.id);

          if (updateError) {
            throw new ApiError(500, EARLY_ACCESS_ERROR_MESSAGE);
          }

          return EARLY_ACCESS_SUCCESS;
        }
      }

      throw new ApiError(500, EARLY_ACCESS_ERROR_MESSAGE);
    }

    return EARLY_ACCESS_SUCCESS;
  }
};
