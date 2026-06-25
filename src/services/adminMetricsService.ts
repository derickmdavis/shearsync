import { getAppEnvironment } from "../config/env";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row, type RowList } from "./db";

export interface AdminRange {
  startIso: string;
  endIso: string;
  days: number;
}

export interface SetupEvaluation {
  score: number;
  checklist: Record<string, boolean>;
  health: {
    status: "healthy" | "needs_attention" | "at_risk";
    reasons: string[];
  };
  lastMeaningfulActionAt: string | null;
  lastLoginAt: string | null;
}

const MEANINGFUL_EVENT_TYPES = new Set([
  "appointment_created",
  "appointment_completed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_no_show",
  "booking_approved",
  "booking_rejected",
  "client_created",
  "client_updated",
  "service_created",
  "service_updated",
  "business_hours_updated",
  "booking_page_enabled",
  "automation_enabled",
  "automation_disabled",
  "payment_shortcut_created",
  "payment_shortcut_updated",
  "payment_shortcut_disabled",
  "waitlist_entry_created",
  "referral_link_created",
  "referral_link_clicked"
]);

export const createAdminRange = (rangeText = "30d"): AdminRange => {
  const match = /^(\d{1,3})d$/.exec(rangeText.trim());
  const days = match ? Math.min(365, Math.max(1, Number(match[1]))) : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    days
  };
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const toNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const getString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const countBy = (rows: RowList, key: string, value: unknown): number =>
  rows.filter((row) => row[key] === value).length;

const countRowsForUser = (rows: RowList, userId: string): number =>
  rows.filter((row) => row.user_id === userId || row.account_user_id === userId).length;

const latestIso = (values: Array<string | null | undefined>): string | null =>
  values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1) ?? null;

const getLastLoginAt = (productEvents: RowList): string | null =>
  latestIso(productEvents
    .filter((event) => event.event_type === "user_opened_app")
    .map((event) => getString(event.created_at)));

const percentile = (values: number[], percentileRank: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
};

const selectAll = async (table: string, columns = "*"): Promise<RowList> => {
  const { data, error } = await supabaseAdmin.from(table).select(columns);
  handleSupabaseError(error, `Unable to load ${table}`);
  return (data ?? []) as unknown as RowList;
};

const selectSince = async (table: string, column: string, startIso: string, columns = "*"): Promise<RowList> => {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(columns)
    .gte(column, startIso);
  handleSupabaseError(error, `Unable to load ${table}`);
  return (data ?? []) as unknown as RowList;
};

const selectTelemetrySince = async (table: string, startIso: string, columns = "*"): Promise<RowList> => {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(columns)
    .eq("environment", getAppEnvironment())
    .gte("created_at", startIso);
  handleSupabaseError(error, `Unable to load ${table}`);
  return (data ?? []) as unknown as RowList;
};

export const adminMetricsService = {
  async loadMetricInputs(range: AdminRange) {
    const last7Iso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last24Iso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [
      users,
      stylists,
      services,
      availability,
      clients,
      appointments,
      paymentMethods,
      automationSettings,
      productEvents,
      notificationEvents,
      bookingErrors,
      apiRequestLogs,
      jobRuns
    ] = await Promise.all([
      selectAll("users", "id, email, business_name, full_name, timezone, plan_tier, plan_status, created_at"),
      selectAll("stylists", "user_id, slug, display_name, booking_enabled, created_at"),
      selectAll("services", "id, user_id, is_active, visible, created_at"),
      selectAll("availability", "id, user_id, is_active, created_at"),
      selectAll("clients", "id, user_id, created_at"),
      selectAll("appointments", "id, user_id, client_id, status, booking_source, price, appointment_date, created_at"),
      selectAll("payment_methods", "id, user_id, is_active, created_at"),
      selectAll("automation_settings", "id, user_id, key, enabled, created_at"),
      selectTelemetrySince("product_events", range.startIso, "id, account_user_id, event_type, created_at, metadata"),
      selectTelemetrySince("notification_events", range.startIso, "id, account_user_id, notification_type, channel, status, created_at"),
      selectTelemetrySince("booking_error_events", range.startIso, "id, account_user_id, severity, created_at"),
      selectTelemetrySince("api_request_logs", last24Iso, "id, duration_ms, status_code, severity, created_at"),
      selectTelemetrySince("job_runs", last24Iso, "id, job_name, status, finished_at, created_at")
    ]);

    const productEvents7 = productEvents.filter((event) => String(event.created_at ?? "") >= last7Iso);
    return {
      range,
      last7Iso,
      last24Iso,
      users,
      stylists,
      services,
      availability,
      clients,
      appointments,
      paymentMethods,
      automationSettings,
      productEvents,
      productEvents7,
      notificationEvents,
      bookingErrors,
      apiRequestLogs,
      jobRuns
    };
  },

  evaluateSetup(input: {
    user: Row;
    stylist: Row | null;
    services: RowList;
    availability: RowList;
    clients: RowList;
    appointments: RowList;
    paymentMethods: RowList;
    automationSettings: RowList;
    productEvents: RowList;
    notificationEvents: RowList;
    bookingErrors: RowList;
  }): SetupEvaluation {
    const userId = String(input.user.id ?? "");
    const userServices = input.services.filter((row) => row.user_id === userId);
    const userAvailability = input.availability.filter((row) => row.user_id === userId);
    const userClients = input.clients.filter((row) => row.user_id === userId);
    const userAppointments = input.appointments.filter((row) => row.user_id === userId);
    const userPaymentMethods = input.paymentMethods.filter((row) => row.user_id === userId);
    const userAutomationSettings = input.automationSettings.filter((row) => row.user_id === userId);
    const userProductEvents = input.productEvents.filter((row) => row.account_user_id === userId);
    const userNotifications = input.notificationEvents.filter((row) => row.account_user_id === userId);
    const userBookingErrors = input.bookingErrors.filter((row) => row.account_user_id === userId);

    const checklist = {
      profileComplete: Boolean(getString(input.user.business_name) || getString(input.stylist?.display_name)),
      bookingPageEnabled: input.stylist?.booking_enabled === true,
      servicesConfigured: userServices.some((row) => row.is_active !== false && row.visible !== false),
      businessHoursConfigured: userAvailability.some((row) => row.is_active !== false),
      timezoneSet: Boolean(getString(input.user.timezone)),
      notificationsConfigured: userAutomationSettings.some((row) => row.enabled === true && ["appointment_reminders", "email_confirmations"].includes(String(row.key ?? ""))),
      paymentShortcutAdded: userPaymentMethods.some((row) => row.is_active !== false),
      firstClientCreated: userClients.length > 0,
      firstAppointmentCreated: userAppointments.length > 0,
      automationEnabled: userAutomationSettings.some((row) => row.enabled === true)
    };
    const score = Object.values(checklist).filter(Boolean).length * 10;
    const meaningfulEvents = userProductEvents.filter((event) => MEANINGFUL_EVENT_TYPES.has(String(event.event_type ?? "")));
    const lastMeaningfulActionAt = latestIso([
      ...meaningfulEvents.map((event) => getString(event.created_at)),
      ...userAppointments.map((appointment) => getString(appointment.created_at)),
      ...userClients.map((client) => getString(client.created_at))
    ]);
    const lastLoginAt = getLastLoginAt(userProductEvents);
    const lastLoginOrMeaningfulActionAt = latestIso([lastMeaningfulActionAt, lastLoginAt]);
    const nowMs = Date.now();
    const last7Iso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const daysSinceLoginOrMeaningfulAction = lastLoginOrMeaningfulActionAt
      ? (nowMs - new Date(lastLoginOrMeaningfulActionAt).getTime()) / (24 * 60 * 60 * 1000)
      : Number.POSITIVE_INFINITY;
    const appointmentsLast30 = userAppointments.filter((row) => String(row.created_at ?? "") >= new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString()).length;
    const pendingApprovals = userAppointments.filter((row) => row.status === "pending").length;
    const notificationFailuresLast7 = userNotifications.filter((row) => row.status === "failed" && String(row.created_at ?? "") >= last7Iso).length;
    const criticalFailuresLast7 = [
      ...userNotifications.filter((row) => row.status === "failed" && String(row.created_at ?? "") >= last7Iso),
      ...userBookingErrors.filter((row) => row.severity === "critical" && String(row.created_at ?? "") >= last7Iso)
    ].length;
    const repeatedBookingErrors = userBookingErrors.filter((row) => String(row.created_at ?? "") >= last7Iso).length >= 3;
    const reasons: string[] = [];

    if (score < 70) reasons.push("setup_score_below_70");
    if (appointmentsLast30 === 0) reasons.push("no_appointments_last_30_days");
    if (!checklist.bookingPageEnabled) reasons.push("booking_page_disabled");
    if (pendingApprovals >= 5) reasons.push("high_pending_approvals");
    if (notificationFailuresLast7 > 0) reasons.push("notification_failures");
    if (criticalFailuresLast7 > 0) reasons.push("critical_failures_last_7_days");

    let status: SetupEvaluation["health"]["status"] = "healthy";
    if (
      daysSinceLoginOrMeaningfulAction >= 14
      || score < 40
      || notificationFailuresLast7 >= 3
      || repeatedBookingErrors
      || !checklist.servicesConfigured
      || !checklist.businessHoursConfigured
    ) {
      status = "at_risk";
    } else if (reasons.length > 0) {
      status = "needs_attention";
    }

    return {
      score,
      checklist,
      lastMeaningfulActionAt,
      lastLoginAt,
      health: {
        status,
        reasons
      }
    };
  },

  summarizeApiLogs(apiRequestLogs: RowList) {
    const durations = apiRequestLogs.map((row) => toNumber(row.duration_ms)).filter((value) => value > 0);
    return {
      averageMs: durations.length ? Math.round(sum(durations) / durations.length) : 0,
      p95Ms: Math.round(percentile(durations, 95)),
      errorCount: apiRequestLogs.filter((row) => toNumber(row.status_code) >= 500).length
    };
  },

  getRevenue(appointments: RowList) {
    return {
      recorded: sum(appointments.filter((row) => row.status === "completed").map((row) => toNumber(row.price))),
      source: "appointment_price_fallback" as const
    };
  },

  countBy,
  countRowsForUser,
  getLastLoginAt
};
