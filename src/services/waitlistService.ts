import { ApiError, requireFound } from "../lib/errors";
import { canUseWaitlist } from "../lib/plans";
import { supabaseAdmin } from "../lib/supabase";
import { addDays, getCurrentLocalDate } from "../lib/timezone";
import type { WaitlistEntry, WaitlistStatus } from "../types/api";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import { entitlementsService } from "./entitlementsService";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";

type WaitlistSource = "public_booking" | "stylist_created" | "manual";

interface WaitlistRow extends Row {
  id: string;
  user_id: string;
  client_id: string | null;
  service_id: string | null;
  service_name?: string | null;
  services?: { name?: string | null } | null;
  requested_date: string;
  requested_time_preference: string | null;
  client_name: string;
  client_email: string | null;
  client_phone: string | null;
  note: string | null;
  status: WaitlistStatus;
  source: WaitlistSource;
  created_at: string;
  updated_at: string;
}

interface CreateWaitlistEntryInput {
  requestedDate: string;
  serviceId?: string | null;
  requestedTimePreference?: string | null;
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  note?: string | null;
}

interface UpdateWaitlistEntryInput extends Partial<CreateWaitlistEntryInput> {
  status?: WaitlistStatus;
}

interface ListWaitlistFilters {
  status?: WaitlistStatus;
  startDate?: string;
  endDate?: string;
  serviceId?: string;
  limit?: number;
}

const WAITLIST_SELECT = `
  id,
  user_id,
  client_id,
  service_id,
  requested_date,
  requested_time_preference,
  client_name,
  client_email,
  client_phone,
  note,
  status,
  source,
  created_at,
  updated_at,
  services(name)
`;

const normalizeContact = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
};

const toWaitlistEntry = (row: WaitlistRow): WaitlistEntry => ({
  id: row.id,
  requestedDate: row.requested_date,
  serviceId: row.service_id,
  serviceName: row.services?.name ?? row.service_name ?? null,
  requestedTimePreference: row.requested_time_preference,
  clientName: row.client_name,
  clientEmail: row.client_email,
  clientPhone: row.client_phone,
  note: row.note,
  status: row.status,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const getFeatureAvailableForUser = async (userId: string): Promise<boolean> => {
  const entitlements = await entitlementsService.getEntitlementsForUser(userId);
  return entitlements.status !== "cancelled" && canUseWaitlist(entitlements.tier);
};

const assertWaitlistAvailableForUser = async (userId: string, message = "Waitlist is not available for this stylist.") => {
  if (!(await getFeatureAvailableForUser(userId))) {
    throw new ApiError(403, message);
  }
};

const assertRequestedDateIsCurrent = async (userId: string, requestedDate: string) => {
  const timeZone = await businessTimeZoneService.getForUser(userId);
  if (requestedDate < getCurrentLocalDate(timeZone)) {
    throw new ApiError(400, "Requested date must be today or later.");
  }
};

const assertServiceBelongsToStylist = async (userId: string, serviceId?: string | null, publicOnly = false) => {
  if (!serviceId) {
    return;
  }

  if (publicOnly) {
    const service = await servicesService.getActiveForStylist(userId, serviceId);
    if (!service) {
      throw new ApiError(400, "Service does not belong to this stylist.");
    }
    return;
  }

  const count = await servicesService.countOwnedByIds(userId, [serviceId]);
  if (count !== 1) {
    throw new ApiError(400, "Service does not belong to this stylist.");
  }
};

const findMatchingClientId = async (userId: string, input: CreateWaitlistEntryInput): Promise<string | null> => {
  const match = await clientsService.findMatchingForBooking(userId, {
    email: normalizeContact(input.clientEmail),
    phone: input.clientPhone,
    phoneNormalized: input.clientPhone
  });

  return (match?.id as string | undefined) ?? null;
};

const assertNoDuplicateActiveEntry = async (
  userId: string,
  input: CreateWaitlistEntryInput,
  exceptId?: string
): Promise<void> => {
  let query = supabaseAdmin
    .from("waitlist_entries")
    .select("id, service_id, client_email, client_phone")
    .eq("user_id", userId)
    .eq("requested_date", input.requestedDate)
    .eq("status", "active");

  if (exceptId) {
    query = query.neq("id", exceptId);
  }

  const { data, error } = await query;
  handleSupabaseError(error, "Unable to validate waitlist entry");

  const email = normalizeContact(input.clientEmail);
  const phone = normalizeContact(input.clientPhone);
  const serviceId = input.serviceId ?? null;
  const duplicate = ((data ?? []) as WaitlistRow[]).some((entry) => {
    const sameService = (entry.service_id ?? null) === serviceId;
    const sameEmail = email && normalizeContact(entry.client_email) === email;
    const samePhone = phone && normalizeContact(entry.client_phone) === phone;
    return sameService && (sameEmail || samePhone);
  });

  if (duplicate) {
    throw new ApiError(409, "This client is already on the waitlist for that date.");
  }
};

const insertWaitlistEntry = async (
  userId: string,
  input: CreateWaitlistEntryInput,
  source: WaitlistSource
): Promise<WaitlistEntry> => {
  await assertRequestedDateIsCurrent(userId, input.requestedDate);
  await assertNoDuplicateActiveEntry(userId, input);
  const clientId = await findMatchingClientId(userId, input);

  const { data, error } = await supabaseAdmin
    .from("waitlist_entries")
    .insert({
      user_id: userId,
      client_id: clientId,
      service_id: input.serviceId ?? null,
      requested_date: input.requestedDate,
      requested_time_preference: input.requestedTimePreference ?? null,
      client_name: input.clientName,
      client_email: normalizeContact(input.clientEmail),
      client_phone: input.clientPhone ?? null,
      note: input.note ?? null,
      status: "active",
      source
    })
    .select(WAITLIST_SELECT)
    .single();

  handleSupabaseError(error, "Unable to create waitlist entry");
  return toWaitlistEntry(requireFound(data as WaitlistRow | null, "Waitlist entry was not created"));
};

export const waitlistService = {
  async canUseWaitlistForUser(userId: string): Promise<boolean> {
    return getFeatureAvailableForUser(userId);
  },

  async canUseWaitlistForPublicStylistSlug(slug: string): Promise<boolean> {
    const stylist = await stylistsService.getBySlug(slug);
    return getFeatureAvailableForUser(stylist.user_id as string);
  },

  async listWaitlistEntries(userId: string, filters: ListWaitlistFilters = {}): Promise<WaitlistEntry[]> {
    let query = supabaseAdmin
      .from("waitlist_entries")
      .select(WAITLIST_SELECT)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (filters.status) {
      query = query.eq("status", filters.status);
    }

    if (filters.startDate) {
      query = query.gte("requested_date", filters.startDate);
    }

    if (filters.endDate) {
      query = query.lt("requested_date", addDays(filters.endDate, 1));
    }

    if (filters.serviceId) {
      query = query.eq("service_id", filters.serviceId);
    }

    query = query.limit(filters.limit ?? 50);

    const { data, error } = await query;
    handleSupabaseError(error, "Unable to load waitlist entries");
    return ((data ?? []) as WaitlistRow[]).map(toWaitlistEntry);
  },

  async getWaitlistEntry(userId: string, waitlistEntryId: string): Promise<WaitlistEntry> {
    const { data, error } = await supabaseAdmin
      .from("waitlist_entries")
      .select(WAITLIST_SELECT)
      .eq("id", waitlistEntryId)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load waitlist entry");
    return toWaitlistEntry(requireFound(data as WaitlistRow | null, "Waitlist entry not found"));
  },

  async createPublicWaitlistEntry(slug: string, input: CreateWaitlistEntryInput): Promise<WaitlistEntry> {
    const stylist = await stylistsService.getBySlug(slug);
    const userId = stylist.user_id as string;
    await assertWaitlistAvailableForUser(userId);
    await assertServiceBelongsToStylist(userId, input.serviceId, true);
    return insertWaitlistEntry(userId, input, "public_booking");
  },

  async createStylistWaitlistEntry(userId: string, input: CreateWaitlistEntryInput): Promise<WaitlistEntry> {
    await assertWaitlistAvailableForUser(userId, "Waitlist is not available for the current plan.");
    await assertServiceBelongsToStylist(userId, input.serviceId);
    return insertWaitlistEntry(userId, input, "stylist_created");
  },

  async updateWaitlistEntry(userId: string, waitlistEntryId: string, input: UpdateWaitlistEntryInput): Promise<WaitlistEntry> {
    await this.getWaitlistEntry(userId, waitlistEntryId);
    await assertWaitlistAvailableForUser(userId, "Waitlist is not available for the current plan.");
    await assertServiceBelongsToStylist(userId, input.serviceId);

    if (input.requestedDate) {
      await assertRequestedDateIsCurrent(userId, input.requestedDate);
    }

    if (input.requestedDate || input.serviceId !== undefined || input.clientEmail !== undefined || input.clientPhone !== undefined) {
      const existing = await this.getWaitlistEntry(userId, waitlistEntryId);
      await assertNoDuplicateActiveEntry(
        userId,
        {
          requestedDate: input.requestedDate ?? existing.requestedDate,
          serviceId: input.serviceId === undefined ? existing.serviceId : input.serviceId,
          clientName: input.clientName ?? existing.clientName,
          clientEmail: input.clientEmail === undefined ? existing.clientEmail : input.clientEmail,
          clientPhone: input.clientPhone === undefined ? existing.clientPhone : input.clientPhone
        },
        waitlistEntryId
      );
    }

    const updates: Row = {};
    if (input.requestedDate !== undefined) updates.requested_date = input.requestedDate;
    if (input.serviceId !== undefined) updates.service_id = input.serviceId;
    if (input.requestedTimePreference !== undefined) updates.requested_time_preference = input.requestedTimePreference;
    if (input.clientName !== undefined) updates.client_name = input.clientName;
    if (input.clientEmail !== undefined) updates.client_email = normalizeContact(input.clientEmail);
    if (input.clientPhone !== undefined) updates.client_phone = input.clientPhone;
    if (input.note !== undefined) updates.note = input.note;
    if (input.status !== undefined) updates.status = input.status;

    if (Object.keys(updates).length === 0) {
      return this.getWaitlistEntry(userId, waitlistEntryId);
    }

    const { data, error } = await supabaseAdmin
      .from("waitlist_entries")
      .update(updates)
      .eq("id", waitlistEntryId)
      .eq("user_id", userId)
      .select(WAITLIST_SELECT)
      .maybeSingle();

    handleSupabaseError(error, "Unable to update waitlist entry");
    return toWaitlistEntry(requireFound(data as WaitlistRow | null, "Waitlist entry not found"));
  },

  async deleteWaitlistEntry(userId: string, waitlistEntryId: string): Promise<void> {
    await this.getWaitlistEntry(userId, waitlistEntryId);
    await assertWaitlistAvailableForUser(userId, "Waitlist is not available for the current plan.");

    const { data, error } = await supabaseAdmin
      .from("waitlist_entries")
      .delete()
      .eq("id", waitlistEntryId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    handleSupabaseError(error, "Unable to delete waitlist entry");
    requireFound(data, "Waitlist entry not found");
  }
};
