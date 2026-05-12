import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { addDays } from "../lib/timezone";
import type { OffDay } from "../types/api";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

interface OffDayRow extends Row {
  id: string;
  user_id: string;
  date: string;
  label: string | null;
  reason: string | null;
  is_recurring: boolean;
  created_at: string;
  updated_at: string;
}

interface ListOffDaysFilters {
  startDate?: string;
  endDate?: string;
}

interface CreateOffDayInput {
  date: string;
  label?: string | null;
  reason?: string | null;
  isRecurring?: boolean;
}

type UpdateOffDayInput = Partial<CreateOffDayInput>;

const OFF_DAY_SELECT = "id, user_id, date, label, reason, is_recurring, created_at, updated_at";

const toOffDay = (row: OffDayRow): OffDay => ({
  id: row.id,
  date: row.date,
  label: row.label,
  reason: row.reason,
  isRecurring: row.is_recurring,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const isUniqueViolation = (error: { code?: string | null } | null): boolean => error?.code === "23505";

const assertNoDuplicateDate = async (userId: string, date: string, exceptId?: string): Promise<void> => {
  let query = supabaseAdmin
    .from("stylist_off_days")
    .select("id")
    .eq("user_id", userId)
    .eq("date", date)
    .limit(1);

  if (exceptId) {
    query = query.neq("id", exceptId);
  }

  const { data, error } = await query.maybeSingle();
  handleSupabaseError(error, "Unable to validate off day");

  if (data) {
    throw new ApiError(409, "An off day already exists for this date");
  }
};

export const offDaysService = {
  async listOffDays(userId: string, filters: ListOffDaysFilters = {}): Promise<OffDay[]> {
    let query = supabaseAdmin
      .from("stylist_off_days")
      .select(OFF_DAY_SELECT)
      .eq("user_id", userId)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    if (filters.startDate) {
      query = query.gte("date", filters.startDate);
    }

    if (filters.endDate) {
      query = query.lt("date", addDays(filters.endDate, 1));
    }

    const { data, error } = await query;
    handleSupabaseError(error, "Unable to load off days");
    return ((data ?? []) as OffDayRow[]).map(toOffDay);
  },

  async createOffDay(userId: string, input: CreateOffDayInput): Promise<OffDay> {
    await assertNoDuplicateDate(userId, input.date);

    const { data, error } = await supabaseAdmin
      .from("stylist_off_days")
      .insert({
        user_id: userId,
        date: input.date,
        label: input.label ?? null,
        reason: input.reason ?? null,
        is_recurring: input.isRecurring ?? false
      })
      .select(OFF_DAY_SELECT)
      .single();

    if (isUniqueViolation(error)) {
      throw new ApiError(409, "An off day already exists for this date");
    }

    handleSupabaseError(error, "Unable to create off day");
    return toOffDay(requireFound(data as OffDayRow | null, "Off day was not created"));
  },

  async createOffDays(userId: string, inputs: CreateOffDayInput[]): Promise<OffDay[]> {
    const uniqueDates = new Set(inputs.map((input) => input.date));

    if (uniqueDates.size !== inputs.length) {
      throw new ApiError(409, "Bulk off day dates must not contain duplicates");
    }

    for (const date of uniqueDates) {
      await assertNoDuplicateDate(userId, date);
    }

    const { data, error } = await supabaseAdmin
      .from("stylist_off_days")
      .insert(
        inputs.map((input) => ({
          user_id: userId,
          date: input.date,
          label: input.label ?? null,
          reason: input.reason ?? null,
          is_recurring: input.isRecurring ?? false
        }))
      )
      .select(OFF_DAY_SELECT);

    if (isUniqueViolation(error)) {
      throw new ApiError(409, "An off day already exists for one of these dates");
    }

    handleSupabaseError(error, "Unable to create off days");
    return ((data ?? []) as OffDayRow[]).map(toOffDay);
  },

  async updateOffDay(userId: string, offDayId: string, input: UpdateOffDayInput): Promise<OffDay> {
    if (input.date !== undefined) {
      await assertNoDuplicateDate(userId, input.date, offDayId);
    }

    const updates: Row = {};
    if (input.date !== undefined) updates.date = input.date;
    if (input.label !== undefined) updates.label = input.label;
    if (input.reason !== undefined) updates.reason = input.reason;
    if (input.isRecurring !== undefined) updates.is_recurring = input.isRecurring;

    if (Object.keys(updates).length === 0) {
      const { data, error } = await supabaseAdmin
        .from("stylist_off_days")
        .select(OFF_DAY_SELECT)
        .eq("id", offDayId)
        .eq("user_id", userId)
        .maybeSingle();

      handleSupabaseError(error, "Unable to load off day");
      return toOffDay(requireFound(data as OffDayRow | null, "Off day not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("stylist_off_days")
      .update(updates)
      .eq("id", offDayId)
      .eq("user_id", userId)
      .select(OFF_DAY_SELECT)
      .maybeSingle();

    if (isUniqueViolation(error)) {
      throw new ApiError(409, "An off day already exists for this date");
    }

    handleSupabaseError(error, "Unable to update off day");
    return toOffDay(requireFound(data as OffDayRow | null, "Off day not found"));
  },

  async deleteOffDay(userId: string, offDayId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from("stylist_off_days")
      .delete()
      .eq("id", offDayId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    handleSupabaseError(error, "Unable to delete off day");
    requireFound(data, "Off day not found");
  },

  async getOffDayDatesForRange(userId: string, startDate: string, endDate: string): Promise<Set<string>> {
    const rows = await this.listOffDays(userId, { startDate, endDate });
    return new Set(rows.map((row) => row.date));
  },

  async isOffDay(userId: string, date: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from("stylist_off_days")
      .select("id")
      .eq("user_id", userId)
      .eq("date", date)
      .limit(1)
      .maybeSingle();

    handleSupabaseError(error, "Unable to validate off day");
    return Boolean(data);
  }
};
