import { randomBytes } from "crypto";
import { env } from "../config/env";
import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const manageAppointmentPurpose = "manage_appointment";
const defaultShortCodeLength = 10;
const maxShortCodeAttempts = 5;

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

export const generateShortCode = (length = defaultShortCodeLength): string => {
  let code = "";

  while (code.length < length) {
    code += randomBytes(Math.ceil((length * 3) / 4) + 1)
      .toString("base64url")
      .replace(/[O0Il_-]/g, "");
  }

  return code.slice(0, length);
};

const getBaseManageUrl = (): string | null => env.WEB_APP_URL ?? env.CLIENT_APP_URL ?? null;

const getExpiresAt = (appointment: Row, now = new Date()): string => {
  const createdWindow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const appointmentDate = typeof appointment.appointment_date === "string"
    ? new Date(appointment.appointment_date)
    : null;

  if (!appointmentDate || !Number.isFinite(appointmentDate.getTime())) {
    return createdWindow.toISOString();
  }

  const postAppointmentWindow = new Date(appointmentDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  return new Date(Math.max(createdWindow.getTime(), postAppointmentWindow.getTime())).toISOString();
};

const loadStylistRowId = async (userId: string): Promise<string | null> => {
  const { data, error } = await supabaseAdmin
    .from("stylists")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load appointment action link stylist");
  return typeof data?.id === "string" ? data.id : null;
};

export const appointmentActionLinksService = {
  buildManageAppointmentUrl(shortCode: string): string | null {
    const baseUrl = getBaseManageUrl();
    return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/manage/${encodeURIComponent(shortCode)}` : null;
  },

  async getOrCreateAppointmentManageLink(appointment: Row): Promise<Row> {
    const appointmentId = String(appointment.id ?? "");
    const userId = String(appointment.user_id ?? "");
    const clientId = typeof appointment.client_id === "string" ? appointment.client_id : null;

    if (!appointmentId || !userId) {
      throw new ApiError(400, "Appointment cannot be managed");
    }

    const nowIso = new Date().toISOString();
    const { data: existingLinks, error: existingError } = await supabaseAdmin
      .from("appointment_action_links")
      .select("*")
      .eq("appointment_id", appointmentId)
      .eq("purpose", manageAppointmentPurpose)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);

    handleSupabaseError(existingError, "Unable to load appointment manage link");
    const existingLink = ((existingLinks ?? []) as Row[])[0];
    if (existingLink) {
      return existingLink;
    }

    const stylistId = await loadStylistRowId(userId);
    const expiresAt = getExpiresAt(appointment);

    for (let attempt = 0; attempt < maxShortCodeAttempts; attempt += 1) {
      const { data, error } = await supabaseAdmin
        .from("appointment_action_links")
        .insert({
          user_id: userId,
          stylist_id: stylistId,
          appointment_id: appointmentId,
          client_id: clientId,
          short_code: generateShortCode(),
          purpose: manageAppointmentPurpose,
          allowed_actions: ["cancel", "reschedule"],
          expires_at: expiresAt
        })
        .select("*")
        .single();

      if (isUniqueViolation(error)) {
        continue;
      }

      handleSupabaseError(error, "Unable to create appointment manage link");
      return requireFound(data, "Appointment manage link was not created");
    }

    throw new ApiError(500, "Unable to create appointment manage link");
  },

  async resolveAppointmentManageLink(shortCode: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("appointment_action_links")
      .select("*")
      .eq("short_code", shortCode)
      .eq("purpose", manageAppointmentPurpose)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment manage link");
    return data ?? null;
  },

  async markAccessed(linkId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from("appointment_action_links")
      .update({
        last_accessed_at: new Date().toISOString()
      })
      .eq("id", linkId);

    if (error) {
      return;
    }
  }
};
