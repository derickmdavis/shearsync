import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError, requireFound } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { supabaseAdmin } from "../lib/supabase";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row, RowList } from "./db";
import { getMissingColumnName, handleSupabaseError, isMissingColumnError, normalizeEmptyString } from "./db";
import { evaluateClientRebookStatus } from "./rebookService";

const CLIENT_LIST_SELECT =
  "id, user_id, first_name, last_name, phone, email, birthday, notes, created_at, updated_at";

const CLIENT_COMPATIBILITY_COLUMNS = new Set([
  "preferred_name",
  "phone_normalized",
  "instagram",
  "preferred_contact_method",
  "tags",
  "source",
  "reminder_consent",
  "total_spend",
  "last_visit_at"
]);

const CLIENT_OPTIONAL_DEFAULTS: Row = {
  preferred_name: null,
  phone_normalized: null,
  instagram: null,
  preferred_contact_method: null,
  tags: null,
  source: null,
  reminder_consent: null,
  total_spend: null,
  last_visit_at: null
};

const stripLeadingAt = (value: string | undefined): string | undefined => {
  const normalized = normalizeEmptyString(value)?.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/^@+/, "");
};

const normalizeTagList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tags = value
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter((tag) => tag.length > 0);

  return tags.length > 0 ? Array.from(new Set(tags)) : [];
};

const sanitizeClientPayload = (payload: Row): Row => {
  const normalizedPhoneValue =
    payload.phone === null ? null : normalizeEmptyString(payload.phone as string | undefined) ?? undefined;

  const sanitized: Row = {
    email: payload.email === null ? null : normalizeEmptyString(payload.email as string | undefined)?.toLowerCase(),
    first_name: payload.first_name === null ? null : normalizeEmptyString(payload.first_name as string | undefined),
    last_name: payload.last_name === null ? null : normalizeEmptyString(payload.last_name as string | undefined),
    preferred_name:
      payload.preferred_name === null ? null : normalizeEmptyString(payload.preferred_name as string | undefined),
    phone: normalizedPhoneValue,
    instagram: payload.instagram === null ? null : stripLeadingAt(payload.instagram as string | undefined),
    birthday: payload.birthday,
    preferred_contact_method: payload.preferred_contact_method,
    notes: payload.notes === null ? null : normalizeEmptyString(payload.notes as string | undefined),
    tags: payload.tags === null ? null : normalizeTagList(payload.tags),
    source: payload.source,
    reminder_consent: payload.reminder_consent,
    total_spend: payload.total_spend,
    last_visit_at: payload.last_visit_at
  };

  if (payload.phone !== undefined) {
    sanitized.phone_normalized = normalizedPhoneValue ? normalizePhone(normalizedPhoneValue) ?? null : null;
  }

  return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined));
};

const normalizeBookingLookup = (payload: Row): { email?: string; phone?: string; phoneNormalized?: string } => {
  const email = normalizeEmptyString(payload.email as string | undefined)?.toLowerCase();
  const phone = normalizeEmptyString(payload.phone as string | undefined);
  const phoneNormalized = phone ? normalizePhone(phone) ?? undefined : undefined;

  return {
    email,
    phone,
    phoneNormalized
  };
};

const normalizeClientRecord = (client: Row): Row => {
  const { unread_message_count: _unusedUnreadMessageCount, ...clientWithoutMessages } = client;
  return { ...CLIENT_OPTIONAL_DEFAULTS, ...clientWithoutMessages };
};

const enrichClients = (clients: RowList, appointments: RowList, timeZone: string, now = new Date()): RowList => {
  const appointmentsByClientId = new Map<string, RowList>();
  const nowIso = now.toISOString();

  for (const appointment of appointments) {
    const clientId = appointment.client_id;
    if (typeof clientId !== "string") {
      continue;
    }

    const existing = appointmentsByClientId.get(clientId) ?? [];
    existing.push(appointment);
    appointmentsByClientId.set(clientId, existing);
  }

  return clients.map((client) => {
    const normalizedClient = normalizeClientRecord(client);
    const clientId = client.id;
    const clientAppointments = typeof clientId === "string" ? appointmentsByClientId.get(clientId) ?? [] : [];
    const nextAppointment = clientAppointments.find((appointment) => {
      const appointmentDate = appointment.appointment_date;
      return typeof appointmentDate === "string" && appointmentDate > nowIso;
    });
    const lastCompletedAppointment = [...clientAppointments]
      .reverse()
      .find((appointment) => {
        const appointmentDate = appointment.appointment_date;
        return typeof appointmentDate === "string" && appointmentDate <= nowIso;
      });
    const nextAppointmentAt = (nextAppointment?.appointment_date as string | undefined) ?? null;
    const hasFutureAppointment = nextAppointmentAt !== null;
    const { needsRebook } = evaluateClientRebookStatus(clientAppointments, timeZone, now);

    return {
      ...normalizedClient,
      next_appointment_at: nextAppointmentAt,
      has_future_appointment: hasFutureAppointment,
      needs_rebook: needsRebook,
      last_service: (lastCompletedAppointment?.service_name as string | undefined) ?? null
    };
  });
};

const removeUnsupportedClientColumn = (payload: Row, column: string): Row | null => {
  if (!CLIENT_COMPATIBILITY_COLUMNS.has(column) || !(column in payload)) {
    return null;
  }

  const nextPayload = { ...payload };
  delete nextPayload[column];
  return nextPayload;
};

const executeClientWriteWithCompatibility = async <T>(
  payload: Row,
  execute: (nextPayload: Row) => PromiseLike<{ data: T; error: PostgrestError | null }>,
  fallbackMessage: string
): Promise<T> => {
  let nextPayload = payload;
  const removedColumns = new Set<string>();

  while (true) {
    const result = await execute(nextPayload);

    if (!result.error) {
      return result.data;
    }

    const missingColumn = getMissingColumnName(result.error);
    if (!missingColumn || removedColumns.has(missingColumn)) {
      handleSupabaseError(result.error, fallbackMessage);
      throw new Error("Unreachable");
    }

    const strippedPayload = removeUnsupportedClientColumn(nextPayload, missingColumn);
    if (!strippedPayload) {
      handleSupabaseError(result.error, fallbackMessage);
      throw new Error("Unreachable");
    }

    removedColumns.add(missingColumn);
    nextPayload = strippedPayload;
  }
};

export const clientsService = {
  async list(userId: string): Promise<RowList> {
    const { data: clients, error } = await supabaseAdmin
      .from("clients")
      .select(CLIENT_LIST_SELECT)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    handleSupabaseError(error, "Unable to load clients");
    if (!clients || clients.length === 0) {
      return [];
    }

    const clientIds = clients
      .map((client) => client.id)
      .filter((clientId): clientId is string => typeof clientId === "string");
    const now = new Date();
    const [timeZone, appointmentsResult] = await Promise.all([
      businessTimeZoneService.getForUser(userId),
      supabaseAdmin
        .from("appointments")
        .select("client_id, appointment_date, service_name")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .in("client_id", clientIds)
        .order("appointment_date", { ascending: true })
    ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load client summary metadata");
    return enrichClients(clients, appointmentsResult.data ?? [], timeZone, now);
  },

  async create(userId: string, payload: Row): Promise<Row> {
    const data = await executeClientWriteWithCompatibility<Row | null>(
      { ...sanitizeClientPayload(payload), user_id: userId },
      (nextPayload) =>
        supabaseAdmin
          .from("clients")
          .insert(nextPayload)
          .select("*")
          .single(),
      "Unable to create client"
    );
    const createdClient = requireFound(data, "Client was not created");
    return this.getById(userId, createdClient.id as string);
  },

  async getById(userId: string, clientId: string): Promise<Row> {
    const { data: client, error } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load client");
    const resolvedClient = requireFound(client, "Client not found");
    const now = new Date();
    const [timeZone, appointmentsResult] = await Promise.all([
      businessTimeZoneService.getForUser(userId),
      supabaseAdmin
        .from("appointments")
        .select("client_id, appointment_date, service_name")
        .eq("user_id", userId)
        .eq("client_id", clientId)
        .neq("status", "cancelled")
        .order("appointment_date", { ascending: true })
    ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load client summary metadata");
    return requireFound(enrichClients([resolvedClient], appointmentsResult.data ?? [], timeZone, now)[0], "Client not found");
  },

  async update(userId: string, clientId: string, updates: Row): Promise<Row> {
    const data = await executeClientWriteWithCompatibility<Row | null>(
      sanitizeClientPayload(updates),
      (nextPayload) =>
        supabaseAdmin
          .from("clients")
          .update(nextPayload)
          .eq("id", clientId)
          .eq("user_id", userId)
          .select("*")
          .maybeSingle(),
      "Unable to update client"
    );
    requireFound(data, "Client not found");
    return this.getById(userId, clientId);
  },

  async remove(userId: string, clientId: string): Promise<void> {
    await this.getById(userId, clientId);

    const { error } = await supabaseAdmin.from("clients").delete().eq("id", clientId).eq("user_id", userId);
    handleSupabaseError(error, "Unable to delete client");
  },

  async findMatchingForBooking(userId: string, payload: Row): Promise<Row | null> {
    const [existing] = await this.findBookingMatches(userId, payload);
    return existing ?? null;
  },

  async findBookingMatches(userId: string, payload: Row): Promise<RowList> {
    const { email, phone, phoneNormalized } = normalizeBookingLookup(payload);

    if (phoneNormalized) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("phone_normalized", phoneNormalized);

      if (!isMissingColumnError(error, "phone_normalized")) {
        handleSupabaseError(error, "Unable to match booking client");
      }

      if (!error && (data ?? []).length > 0) {
        return data ?? [];
      }
    }

    if (phone) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("phone", phone);

      handleSupabaseError(error, "Unable to match booking client");
      if ((data ?? []).length > 0) {
        return data ?? [];
      }
    }

    if (email) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("email", email);

      handleSupabaseError(error, "Unable to match booking client");
      return data ?? [];
    }

    return [];
  },

  async findOrCreateForBooking(userId: string, payload: Row): Promise<Row> {
    const email = normalizeEmptyString(payload.email as string | undefined)?.toLowerCase();
    const existing = await this.findMatchingForBooking(userId, { ...payload, email });

    if (existing) {
      return existing;
    }

    return this.create(userId, { ...payload, email });
  },

  async listBookingRelevantAppointments(userId: string, clientId: string): Promise<RowList> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("service_name, status, appointment_date")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .neq("status", "cancelled")
      .order("appointment_date", { ascending: false });

    handleSupabaseError(error, "Unable to load client appointments");
    return data ?? [];
  },

  async assertOwned(userId: string, clientId: string): Promise<void> {
    try {
      await this.getById(userId, clientId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        throw new ApiError(400, "Client does not belong to the authenticated user");
      }

      throw error;
    }
  }
};
