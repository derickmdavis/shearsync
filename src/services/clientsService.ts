import { ApiError, requireFound } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { supabaseAdmin } from "../lib/supabase";
import { businessTimeZoneService } from "./businessTimeZoneService";
import type { Row, RowList } from "./db";
import { handleSupabaseError, normalizeEmptyString } from "./db";
import { evaluateClientRebookStatus } from "./rebookService";

const CLIENT_LIST_SELECT =
  "id, user_id, first_name, last_name, preferred_name, phone, phone_normalized, email, instagram, birthday, notes, preferred_contact_method, tags, source, reminder_consent, total_spend, last_visit_at, deleted_at, deleted_reason, purge_after, created_at, updated_at";

const CLIENT_SOFT_DELETE_RETENTION_DAYS = 30;

type ListClientsOptions = {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "updated" | "updated_at" | "name" | "spend" | "total_spend" | "last_visit" | "last_visit_at";
  direction?: "asc" | "desc";
  filter?: "all" | "active" | "vip";
};

type ListClientsResult = {
  data: RowList;
  page: number;
  pageSize: number;
  totalCount: number;
  nextCursor: string | null;
};

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

const normalizeBookingLookup = (payload: Row): { phone?: string; phoneNormalized?: string } => {
  const phone = normalizeEmptyString(payload.phone as string | undefined);
  const phoneNormalized = phone ? normalizePhone(phone) ?? undefined : undefined;

  return {
    phone,
    phoneNormalized
  };
};

const normalizeClientRecord = (client: Row): Row => {
  const { unread_message_count: _unusedUnreadMessageCount, ...clientWithoutMessages } = client;
  return { ...CLIENT_OPTIONAL_DEFAULTS, ...clientWithoutMessages };
};

const escapePostgrestSearchValue = (value: string): string =>
  value.replace(/[%_,()]/g, (character) => `\\${character}`).replace(/"/g, '\\"');

const escapePostgresArrayValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const buildClientSearchFilter = (search: string): string => {
  const escaped = escapePostgrestSearchValue(search);
  const escapedArrayValue = escapePostgresArrayValue(search);
  const pattern = `%${escaped}%`;

  return [
    `first_name.ilike.${pattern}`,
    `last_name.ilike.${pattern}`,
    `preferred_name.ilike.${pattern}`,
    `email.ilike.${pattern}`,
    `phone.ilike.${pattern}`,
    `phone_normalized.ilike.${pattern}`,
    `instagram.ilike.${pattern}`,
    `notes.ilike.${pattern}`,
    `tags.cs.{"${escapedArrayValue}"}`
  ].join(",");
};

const normalizeListOptions = (options: ListClientsOptions = {}): Required<ListClientsOptions> => ({
  search: options.search?.trim() ?? "",
  page: options.page ?? 1,
  pageSize: options.pageSize ?? 25,
  sort: options.sort ?? "updated_at",
  direction: options.direction ?? "desc",
  filter: options.filter ?? "all"
});

const applyClientListFilters = <T extends {
  or: (filters: string) => T;
}>(query: T, options: Required<ListClientsOptions>): T => {
  let nextQuery = query;

  if (options.search) {
    nextQuery = nextQuery.or(buildClientSearchFilter(options.search));
  }

  if (options.filter === "vip") {
    nextQuery = nextQuery.or('tags.cs.{"VIP"},tags.cs.{"vip"}');
  }

  return nextQuery;
};

const applyClientListSort = <T extends {
  order: (column: string, options?: { ascending?: boolean }) => T;
}>(query: T, options: Required<ListClientsOptions>): T => {
  const ascending = options.direction === "asc";

  switch (options.sort) {
    case "name":
      return query.order("last_name", { ascending }).order("first_name", { ascending }).order("id", { ascending: true });
    case "spend":
    case "total_spend":
      return query.order("total_spend", { ascending }).order("id", { ascending: true });
    case "last_visit":
    case "last_visit_at":
      return query.order("last_visit_at", { ascending }).order("id", { ascending: true });
    case "updated":
    case "updated_at":
    default:
      return query.order("updated_at", { ascending }).order("id", { ascending: true });
  }
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

export const clientsService = {
  async list(userId: string, options: ListClientsOptions = {}): Promise<ListClientsResult> {
    const normalizedOptions = normalizeListOptions(options);
    const rangeStart = (normalizedOptions.page - 1) * normalizedOptions.pageSize;
    const rangeEnd = rangeStart + normalizedOptions.pageSize - 1;
    let clientsQuery = supabaseAdmin
      .from("clients")
      .select(CLIENT_LIST_SELECT, { count: "exact" })
      .eq("user_id", userId)
      .is("deleted_at", null);

    clientsQuery = applyClientListFilters(clientsQuery, normalizedOptions);
    clientsQuery = applyClientListSort(clientsQuery, normalizedOptions).range(rangeStart, rangeEnd);

    const { data: clients, error, count } = await clientsQuery;

    handleSupabaseError(error, "Unable to load clients");
    const totalCount = count ?? clients?.length ?? 0;
    const nextCursor = rangeEnd + 1 < totalCount ? String(normalizedOptions.page + 1) : null;

    if (!clients || clients.length === 0) {
      return {
        data: [],
        page: normalizedOptions.page,
        pageSize: normalizedOptions.pageSize,
        totalCount,
        nextCursor
      };
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
    return {
      data: enrichClients(clients, appointmentsResult.data ?? [], timeZone, now),
      page: normalizedOptions.page,
      pageSize: normalizedOptions.pageSize,
      totalCount,
      nextCursor
    };
  },

  async create(userId: string, payload: Row): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .insert({ ...sanitizeClientPayload(payload), user_id: userId })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create client");
    const createdClient = requireFound(data, "Client was not created");
    return this.getById(userId, createdClient.id as string);
  },

  async getById(userId: string, clientId: string): Promise<Row> {
    const { data: client, error } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .eq("user_id", userId)
      .is("deleted_at", null)
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
    const { data, error } = await supabaseAdmin
      .from("clients")
      .update(sanitizeClientPayload(updates))
      .eq("id", clientId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to update client");
    requireFound(data, "Client not found");
    return this.getById(userId, clientId);
  },

  async remove(userId: string, clientId: string): Promise<void> {
    await this.getById(userId, clientId);

    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + CLIENT_SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { error } = await supabaseAdmin
      .from("clients")
      .update({
        deleted_at: deletedAt.toISOString(),
        deleted_reason: "user_deleted",
        purge_after: purgeAfter.toISOString()
      })
      .eq("id", clientId)
      .eq("user_id", userId)
      .is("deleted_at", null);

    handleSupabaseError(error, "Unable to delete client");
  },

  async reactivate(userId: string, clientId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .update({
        deleted_at: null,
        deleted_reason: null,
        purge_after: null
      })
      .eq("id", clientId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to reactivate client");
    requireFound(data, "Client not found");
    return this.getById(userId, clientId);
  },

  async findMatchingForBooking(userId: string, payload: Row): Promise<Row | null> {
    const [existing] = await this.findBookingMatches(userId, payload);
    return existing ?? null;
  },

  async findBookingMatches(userId: string, payload: Row): Promise<RowList> {
    const { phone, phoneNormalized } = normalizeBookingLookup(payload);

    if (phoneNormalized) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("phone_normalized", phoneNormalized)
        .is("deleted_at", null);

      handleSupabaseError(error, "Unable to match booking client");

      if ((data ?? []).length > 0) {
        return data ?? [];
      }
    }

    if (phone) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("phone", phone)
        .is("deleted_at", null);

      handleSupabaseError(error, "Unable to match booking client");
      if ((data ?? []).length > 0) {
        return data ?? [];
      }
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
