import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { BookingSettings } from "../types/api";
import { bookingRulesSchema } from "../validators/settingsValidators";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { servicesService } from "./servicesService";

interface BookingRulesRow extends Row {
  user_id: string;
  lead_time_hours: number;
  same_day_booking_allowed: boolean;
  same_day_booking_cutoff: string;
  max_booking_window_days: number;
  cancellation_window_hours: number;
  late_cancellation_fee_enabled: boolean;
  late_cancellation_fee_type: "flat" | "percent";
  late_cancellation_fee_value: number;
  allow_cancellation_after_cutoff: boolean;
  reschedule_window_hours: number;
  max_reschedules: number | null;
  same_day_rescheduling_allowed: boolean;
  preserve_appointment_history: boolean;
  new_client_approval_required: boolean;
  new_client_booking_window_days: number;
  restrict_services_for_new_clients: boolean;
  restricted_service_ids: string[] | null;
}

const bookingRulesUserConstraintName = "booking_rules_user_id_key";

const isBookingRulesAlreadyCreatedError = (
  error: { code?: string; message?: string; details?: string } | null
): boolean => {
  if (!error || error.code !== "23505") {
    return false;
  }

  const errorText = `${error.message ?? ""} ${error.details ?? ""}`;
  return errorText.includes(bookingRulesUserConstraintName) || errorText.includes("(user_id)");
};

const BOOKING_RULES_SELECT =
  "user_id, lead_time_hours, same_day_booking_allowed, same_day_booking_cutoff, max_booking_window_days, cancellation_window_hours, late_cancellation_fee_enabled, late_cancellation_fee_type, late_cancellation_fee_value, allow_cancellation_after_cutoff, reschedule_window_hours, max_reschedules, same_day_rescheduling_allowed, preserve_appointment_history, new_client_approval_required, new_client_booking_window_days, restrict_services_for_new_clients, restricted_service_ids";

const DEFAULT_BOOKING_RULES_INSERT: Omit<BookingRulesRow, "user_id"> = {
  lead_time_hours: 0,
  same_day_booking_allowed: false,
  same_day_booking_cutoff: "17:00:00",
  max_booking_window_days: 30,
  cancellation_window_hours: 24,
  late_cancellation_fee_enabled: false,
  late_cancellation_fee_type: "flat",
  late_cancellation_fee_value: 0,
  allow_cancellation_after_cutoff: false,
  reschedule_window_hours: 24,
  max_reschedules: null,
  same_day_rescheduling_allowed: false,
  preserve_appointment_history: true,
  new_client_approval_required: false,
  new_client_booking_window_days: 30,
  restrict_services_for_new_clients: false,
  restricted_service_ids: []
};

const toBookingSettings = (row: BookingRulesRow): BookingSettings => ({
  leadTimeHours: row.lead_time_hours,
  sameDayBookingAllowed: row.same_day_booking_allowed,
  sameDayBookingCutoff: row.same_day_booking_cutoff,
  maxBookingWindowDays: row.max_booking_window_days,
  cancellationWindowHours: row.cancellation_window_hours,
  lateCancellationFeeEnabled: row.late_cancellation_fee_enabled,
  lateCancellationFeeType: row.late_cancellation_fee_type,
  lateCancellationFeeValue: Number(row.late_cancellation_fee_value),
  allowCancellationAfterCutoff: row.allow_cancellation_after_cutoff,
  rescheduleWindowHours: row.reschedule_window_hours,
  maxReschedules: row.max_reschedules ?? "unlimited",
  sameDayReschedulingAllowed: row.same_day_rescheduling_allowed,
  preserveAppointmentHistory: row.preserve_appointment_history,
  newClientApprovalRequired: row.new_client_approval_required,
  newClientBookingWindowDays: row.new_client_booking_window_days,
  restrictServicesForNewClients: row.restrict_services_for_new_clients,
  restrictedServiceIds: Array.isArray(row.restricted_service_ids)
    ? row.restricted_service_ids.filter((value): value is string => typeof value === "string")
    : []
});

const toBookingRulesUpdate = (payload: Partial<BookingSettings>): Partial<BookingRulesRow> => {
  const updates: Partial<BookingRulesRow> = {};

  if (payload.leadTimeHours !== undefined) updates.lead_time_hours = payload.leadTimeHours;
  if (payload.sameDayBookingAllowed !== undefined)
    updates.same_day_booking_allowed = payload.sameDayBookingAllowed;
  if (payload.sameDayBookingCutoff !== undefined) updates.same_day_booking_cutoff = payload.sameDayBookingCutoff;
  if (payload.maxBookingWindowDays !== undefined)
    updates.max_booking_window_days = payload.maxBookingWindowDays;
  if (payload.cancellationWindowHours !== undefined)
    updates.cancellation_window_hours = payload.cancellationWindowHours;
  if (payload.lateCancellationFeeEnabled !== undefined)
    updates.late_cancellation_fee_enabled = payload.lateCancellationFeeEnabled;
  if (payload.lateCancellationFeeType !== undefined)
    updates.late_cancellation_fee_type = payload.lateCancellationFeeType;
  if (payload.lateCancellationFeeValue !== undefined)
    updates.late_cancellation_fee_value = payload.lateCancellationFeeValue;
  if (payload.allowCancellationAfterCutoff !== undefined)
    updates.allow_cancellation_after_cutoff = payload.allowCancellationAfterCutoff;
  if (payload.rescheduleWindowHours !== undefined)
    updates.reschedule_window_hours = payload.rescheduleWindowHours;
  if (payload.maxReschedules !== undefined)
    updates.max_reschedules = payload.maxReschedules === "unlimited" || payload.maxReschedules === null
      ? null
      : payload.maxReschedules;
  if (payload.sameDayReschedulingAllowed !== undefined)
    updates.same_day_rescheduling_allowed = payload.sameDayReschedulingAllowed;
  if (payload.preserveAppointmentHistory !== undefined)
    updates.preserve_appointment_history = payload.preserveAppointmentHistory;
  if (payload.newClientApprovalRequired !== undefined)
    updates.new_client_approval_required = payload.newClientApprovalRequired;
  if (payload.newClientBookingWindowDays !== undefined)
    updates.new_client_booking_window_days = payload.newClientBookingWindowDays;
  if (payload.restrictServicesForNewClients !== undefined)
    updates.restrict_services_for_new_clients = payload.restrictServicesForNewClients;
  if (payload.restrictedServiceIds !== undefined) updates.restricted_service_ids = payload.restrictedServiceIds;

  return updates;
};

const assertOwnedRestrictedServices = async (userId: string, serviceIds: string[]): Promise<void> => {
  if (serviceIds.length === 0) {
    return;
  }

  const uniqueServiceIds = [...new Set(serviceIds)];
  const ownedServiceCount = await servicesService.countOwnedByIds(userId, uniqueServiceIds);

  if (ownedServiceCount !== uniqueServiceIds.length) {
    throw new ApiError(400, "restrictedServiceIds must all belong to services owned by the authenticated user");
  }
};

const ensureBookingRules = async (userId: string): Promise<BookingRulesRow> => {
  const { data, error } = await supabaseAdmin
    .from("booking_rules")
    .select(BOOKING_RULES_SELECT)
    .eq("user_id", userId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load booking rules");

  if (data) {
    return data as BookingRulesRow;
  }

  const { data: createdData, error: createdError } = await supabaseAdmin
    .from("booking_rules")
    .insert({ user_id: userId, ...DEFAULT_BOOKING_RULES_INSERT })
    .select(BOOKING_RULES_SELECT)
    .single();

  if (isBookingRulesAlreadyCreatedError(createdError)) {
    const { data: existingData, error: existingError } = await supabaseAdmin
      .from("booking_rules")
      .select(BOOKING_RULES_SELECT)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(existingError, "Unable to load booking rules");
    return requireFound(existingData as BookingRulesRow | null, "Booking rules were not created");
  }

  handleSupabaseError(createdError, "Unable to create booking rules");
  return requireFound(createdData as BookingRulesRow | null, "Booking rules were not created");
};

export const bookingRulesService = {
  async getByUserId(userId: string): Promise<BookingSettings> {
    const row = await ensureBookingRules(userId);
    return toBookingSettings(row);
  },

  async updateForUser(userId: string, payload: Partial<BookingSettings>): Promise<BookingSettings> {
    const currentRow = await ensureBookingRules(userId);
    const nextSettings = bookingRulesSchema.parse({
      ...toBookingSettings(currentRow),
      ...payload
    });

    await assertOwnedRestrictedServices(userId, nextSettings.restrictedServiceIds);

    const updates = toBookingRulesUpdate(payload);

    if (Object.keys(updates).length === 0) {
      return toBookingSettings(currentRow);
    }

    const { data, error } = await supabaseAdmin
      .from("booking_rules")
      .update(updates)
      .eq("user_id", userId)
      .select(BOOKING_RULES_SELECT)
      .maybeSingle();

    handleSupabaseError(error, "Unable to update booking rules");
    return toBookingSettings(requireFound(data as BookingRulesRow | null, "Booking rules were not updated"));
  }
};
