import { ApiError, requireFound } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { supabaseAdmin } from "../lib/supabase";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { recordProductTelemetry } from "./productTelemetry";
import type { Row, RowList } from "./db";
import { handleSupabaseError, normalizeEmptyString } from "./db";
import { evaluateClientRebookStatus } from "./rebookService";
import { campaignAudienceEligibilityService } from "./campaignAudienceEligibilityService";

const CLIENT_SOFT_DELETE_RETENTION_DAYS = 30;

type ListClientsOptions = {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "updated" | "updated_at" | "name" | "spend" | "total_spend" | "last_visit" | "last_visit_at";
  direction?: "asc" | "desc";
  filter?: "all" | "active" | "vip" | "overdue" | "first_time" | "top_spenders";
  campaign_eligibility?: "email_marketing";
};

type ListClientsResult = {
  data: RowList;
  page: number;
  pageSize: number;
  totalCount: number;
  nextCursor: string | null;
  insights: {
    overdue: { count: number; supportingText: string };
    firstTime: { count: number; supportingText: string };
    topSpenders: {
      count: number;
      supportingText: string;
      thresholdAmount: number;
      period: "lifetime";
      percentile: 10;
    };
  };
};

const emptyClientInsights: ListClientsResult["insights"] = {
  overdue: { count: 0, supportingText: "Rebooking due" },
  firstTime: { count: 0, supportingText: "This year" },
  topSpenders: {
    count: 0,
    supportingText: "$0.00+ lifetime",
    thresholdAmount: 0,
    period: "lifetime",
    percentile: 10
  }
};

const CLIENT_OPTIONAL_DEFAULTS: Row = {
  preferred_name: null,
  phone_normalized: null,
  instagram: null,
  preferred_contact_method: null,
  tags: null,
  source: null,
  reminder_consent: null,
  is_vip: false,
  avatar_image_id: null,
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
    original_referral_link_id: payload.original_referral_link_id,
    original_referred_by_client_id: payload.original_referred_by_client_id,
    original_referral_code: payload.original_referral_code,
    original_acquisition_source: payload.original_acquisition_source,
    original_referral_attributed_at: payload.original_referral_attributed_at,
    reminder_consent: payload.reminder_consent,
    is_vip: payload.is_vip,
    avatar_image_id: payload.avatar_image_id,
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

const assertReadyClientAvatarImage = async (userId: string, clientId: string, imageId: string): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from("appointment_images")
    .select("id")
    .eq("id", imageId)
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .eq("upload_status", "ready")
    .maybeSingle();

  handleSupabaseError(error, "Unable to validate client avatar image");
  if (!data) {
    throw new ApiError(400, "Avatar image must be a ready image for this client");
  }
};

const normalizeClientRecord = (client: Row): Row => {
  const { unread_message_count: _unusedUnreadMessageCount, ...clientWithoutMessages } = client;
  return { ...CLIENT_OPTIONAL_DEFAULTS, ...clientWithoutMessages };
};

const normalizeListOptions = (options: ListClientsOptions = {}) => ({
  search: options.search?.trim() ?? "",
  page: options.page ?? 1,
  pageSize: options.pageSize ?? 25,
  sort: options.sort ?? "updated_at",
  direction: options.direction ?? "desc",
  filter: options.filter ?? "all",
  campaign_eligibility: options.campaign_eligibility
});

type NormalizedListClientsOptions = ReturnType<typeof normalizeListOptions>;

// Kept for the single-client endpoint until it is moved to the same SQL-backed
// summary source as the paginated list.
const enrichClients = (clients: RowList, appointments: RowList, timeZone: string, now = new Date()): RowList => {
  const appointmentsByClientId = new Map<string, RowList>();
  const nowIso = now.toISOString();

  for (const appointment of appointments) {
    const clientId = appointment.client_id;
    if (typeof clientId !== "string") continue;
    const existing = appointmentsByClientId.get(clientId) ?? [];
    existing.push(appointment);
    appointmentsByClientId.set(clientId, existing);
  }

  return clients.map((client) => {
    const normalizedClient = normalizeClientRecord(client);
    const clientAppointments = typeof client.id === "string" ? appointmentsByClientId.get(client.id) ?? [] : [];
    const nextAppointment = clientAppointments.find((appointment) =>
      typeof appointment.appointment_date === "string" && appointment.appointment_date > nowIso
    );
    const lastPastAppointment = [...clientAppointments].reverse().find((appointment) =>
      typeof appointment.appointment_date === "string" && appointment.appointment_date <= nowIso
    );
    const nextAppointmentAt = (nextAppointment?.appointment_date as string | undefined) ?? null;
    const { needsRebook } = evaluateClientRebookStatus(clientAppointments, timeZone, now);

    return {
      ...normalizedClient,
      next_appointment_at: nextAppointmentAt,
      has_future_appointment: nextAppointmentAt !== null,
      needs_rebook: needsRebook,
      last_service: (lastPastAppointment?.service_name as string | undefined) ?? null
    };
  });
};

export const clientsService = {
  async list(userId: string, options: ListClientsOptions = {}): Promise<ListClientsResult> {
    const normalizedOptions = normalizeListOptions(options);
    const rpcArgs = {
      p_user_id: userId,
      p_search: normalizedOptions.search || null,
      p_page: normalizedOptions.page,
      p_page_size: normalizedOptions.pageSize,
      p_sort: normalizedOptions.sort,
      p_direction: normalizedOptions.direction,
      p_filter: normalizedOptions.filter
    };
    const { data, error } = await supabaseAdmin.rpc("list_clients_with_summaries", rpcArgs);

    handleSupabaseError(error, "Unable to load clients");
    const rows = (data ?? []) as Array<{
      client: Row;
      total_count: number | string;
      insights: ListClientsResult["insights"];
    }>;
    // PostgreSQL cannot attach a window count to an empty page. Re-read one row
    // only for an out-of-range page so pagination metadata remains accurate.
    const countResult = rows.length === 0 && normalizedOptions.page > 1
      ? await supabaseAdmin.rpc("list_clients_with_summaries", { ...rpcArgs, p_page: 1, p_page_size: 1 })
      : null;
    handleSupabaseError(countResult?.error ?? null, "Unable to load clients");
    const countRows = countResult?.data as Array<{
      total_count: number | string;
      insights: ListClientsResult["insights"];
    }> | null;
    const responseRow = rows[0] ?? countRows?.[0] ?? null;
    const totalCount = rows.length > 0
      ? Number(rows[0].total_count)
      : countRows && countRows.length > 0 ? Number(countRows[0].total_count) : 0;
    const nextCursor = normalizedOptions.page * normalizedOptions.pageSize < totalCount
      ? String(normalizedOptions.page + 1)
      : null;
    const enriched = rows.map((row) => normalizeClientRecord(row.client));
    const eligibility = normalizedOptions.campaign_eligibility
      ? await campaignAudienceEligibilityService.evaluateClients(userId, enriched, { applyDuplicateExclusions: false })
      : [];
    const eligibilityByClientId = new Map(eligibility.map((result) => [result.client_id, result]));
    return {
      data: enriched.map((client) => {
        const result = eligibilityByClientId.get(String(client.id));
        return result ? {
          ...client,
          campaign_eligibility: { eligible: result.eligible, reason: result.reason }
        } : client;
      }),
      page: normalizedOptions.page,
      pageSize: normalizedOptions.pageSize,
      totalCount,
      nextCursor,
      insights: responseRow?.insights ?? emptyClientInsights
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
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      clientId: typeof createdClient.id === "string" ? createdClient.id : null,
      eventType: "client_created",
      eventSource: "backend",
      dedupeKey: typeof createdClient.id === "string" ? `client_created:${createdClient.id}` : null,
      metadata: {
        source: payload.acquisition_source ?? "manual",
        has_email: Boolean(payload.email),
        has_phone: Boolean(payload.phone)
      }
    });
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
    const sanitizedUpdates = sanitizeClientPayload(updates);
    if (sanitizedUpdates.avatar_image_id !== undefined && sanitizedUpdates.avatar_image_id !== null) {
      await assertReadyClientAvatarImage(userId, clientId, String(sanitizedUpdates.avatar_image_id));
    }

    const { data, error } = await supabaseAdmin
      .from("clients")
      .update(sanitizedUpdates)
      .eq("id", clientId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to update client");
    requireFound(data, "Client not found");
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      clientId,
      eventType: "client_updated",
      eventSource: "backend",
      metadata: {
        updated_fields: Object.keys(sanitizedUpdates).filter((field) => !["email", "phone", "notes"].includes(field))
      }
    });
    return this.getById(userId, clientId);
  },

  async updateAvatar(userId: string, clientId: string, avatarImageId: string | null): Promise<Row> {
    return this.update(userId, clientId, { avatar_image_id: avatarImageId });
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

  async findMatchingForBooking(
    userId: string,
    payload: Row,
    options: { includeEmail?: boolean } = {}
  ): Promise<Row | null> {
    const matches = options.includeEmail
      ? await this.findBookingMatchesIncludingEmail(userId, payload)
      : await this.findBookingMatches(userId, payload);
    const [existing] = matches;
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

  async findBookingMatchesIncludingEmail(userId: string, payload: Row): Promise<RowList> {
    const phoneMatches = await this.findBookingMatches(userId, payload);
    if (phoneMatches.length > 0) {
      return phoneMatches;
    }

    const email = normalizeEmptyString(payload.email as string | undefined)?.toLowerCase();
    if (email) {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("user_id", userId)
        .eq("email", email)
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
