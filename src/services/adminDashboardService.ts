import { getAppEnvironment } from "../config/env";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { adminMetricsService, createAdminRange } from "./adminMetricsService";
import { adminAccountNotesService } from "./adminAccountNotesService";

const getString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const toNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const groupByUser = (rows: RowList): Map<string, RowList> => {
  const grouped = new Map<string, RowList>();
  for (const row of rows) {
    const userId = String(row.user_id ?? row.account_user_id ?? "");
    if (!userId) continue;
    grouped.set(userId, [...(grouped.get(userId) ?? []), row]);
  }

  return grouped;
};

const getDisplayName = (user: Row, stylist?: Row | null): string =>
  getString(user.business_name)
  ?? getString(stylist?.display_name)
  ?? getString(user.full_name)
  ?? getString(user.email)
  ?? "Unknown account";

const sortByCreatedDesc = (rows: RowList): RowList =>
  [...rows].sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));

const loadRecentAccountRows = async (table: string, userId: string, columns = "*", limit = 20): Promise<RowList> => {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(columns)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  handleSupabaseError(error, `Unable to load ${table}`);
  return (data ?? []) as unknown as RowList;
};

export const adminDashboardService = {
  async getSystemHealth() {
    const now = new Date();
    const last24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const range = { startIso: last24, endIso: now.toISOString(), days: 1 };
    const inputs = await adminMetricsService.loadMetricInputs(range);
    const api = adminMetricsService.summarizeApiLogs(inputs.apiRequestLogs);
    const failedJobs = inputs.jobRuns.filter((row) => row.status === "failed").length;
    const lastSuccessfulJob = inputs.jobRuns
      .filter((row) => row.status === "completed")
      .sort((left, right) => String(right.finished_at ?? right.created_at ?? "").localeCompare(String(left.finished_at ?? left.created_at ?? "")))[0] ?? null;
    const { error: dbError } = await supabaseAdmin.from("users").select("id").limit(1);

    return {
      environment: getAppEnvironment(),
      api: {
        status: "ok",
        uptimeSeconds: Math.round(process.uptime()),
        latency: api
      },
      db: {
        status: dbError ? "error" : "ok"
      },
      emailQueue: {
        queued: inputs.notificationEvents.filter((row) => row.channel === "email" && row.status === "queued").length,
        sentLast24h: inputs.notificationEvents.filter((row) => row.channel === "email" && row.status === "sent").length,
        failedLast24h: inputs.notificationEvents.filter((row) => row.channel === "email" && row.status === "failed").length
      },
      smsQueue: {
        queued: inputs.notificationEvents.filter((row) => row.channel === "sms" && row.status === "queued").length,
        sentLast24h: inputs.notificationEvents.filter((row) => row.channel === "sms" && row.status === "sent").length,
        failedLast24h: inputs.notificationEvents.filter((row) => row.channel === "sms" && row.status === "failed").length
      },
      jobs: {
        failedLast24h: failedJobs,
        lastSuccessfulRun: lastSuccessfulJob
      },
      bookingErrorsLast24h: inputs.bookingErrors.length
    };
  },

  async getBusinessOverview(rangeText?: string) {
    const range = createAdminRange(rangeText);
    const inputs = await adminMetricsService.loadMetricInputs(range);
    const last7Iso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last30Iso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const meaningfulAccountIds7 = new Set(inputs.productEvents.filter((row) => String(row.created_at ?? "") >= last7Iso).map((row) => String(row.account_user_id ?? "")));
    const meaningfulAccountIds30 = new Set(inputs.productEvents.filter((row) => String(row.created_at ?? "") >= last30Iso).map((row) => String(row.account_user_id ?? "")));
    const usersById = new Map(inputs.users.map((user) => [String(user.id), user]));
    const stylistsByUserId = new Map(inputs.stylists.map((stylist) => [String(stylist.user_id), stylist]));
    const appointmentsInRange = inputs.appointments.filter((row) => String(row.created_at ?? "") >= range.startIso);
    const topActiveAccounts = [...meaningfulAccountIds30]
      .filter(Boolean)
      .slice(0, 10)
      .map((userId) => {
        const user = usersById.get(userId) ?? { id: userId };
        const stylist = stylistsByUserId.get(userId);
        return {
          userId,
          displayName: getDisplayName(user, stylist),
          eventsLast30Days: inputs.productEvents.filter((row) => row.account_user_id === userId).length
        };
      });

    return {
      range,
      totalStylists: inputs.stylists.length,
      activeStylists: {
        last7Days: meaningfulAccountIds7.size,
        last30Days: meaningfulAccountIds30.size
      },
      appointments: {
        bookedInRange: appointmentsInRange.length,
        publicBookingsSubmitted: appointmentsInRange.filter((row) => row.booking_source === "public").length
      },
      clientsCreated: inputs.clients.filter((row) => String(row.created_at ?? "") >= range.startIso).length,
      automations: {
        sent: inputs.notificationEvents.filter((row) => row.status === "sent").length,
        failed: inputs.notificationEvents.filter((row) => row.status === "failed").length
      },
      revenue: adminMetricsService.getRevenue(inputs.appointments.filter((row) => String(row.appointment_date ?? row.created_at ?? "") >= range.startIso)),
      bookingPageViews: inputs.productEvents.filter((row) => row.event_type === "booking_page_viewed").length,
      topActiveAccounts
    };
  },

  async getAccounts(rangeText?: string) {
    const range = createAdminRange(rangeText);
    const inputs = await adminMetricsService.loadMetricInputs(range);
    const stylistsByUserId = new Map(inputs.stylists.map((row) => [String(row.user_id), row]));
    const groupedServices = groupByUser(inputs.services);
    const groupedAvailability = groupByUser(inputs.availability);
    const groupedClients = groupByUser(inputs.clients);
    const groupedAppointments = groupByUser(inputs.appointments);
    const groupedPaymentMethods = groupByUser(inputs.paymentMethods);
    const groupedAutomationSettings = groupByUser(inputs.automationSettings);
    const groupedProductEvents = groupByUser(inputs.productEvents);
    const groupedNotificationEvents = groupByUser(inputs.notificationEvents);
    const groupedBookingErrors = groupByUser(inputs.bookingErrors);

    return inputs.users.map((user) => {
      const userId = String(user.id ?? "");
      const stylist = stylistsByUserId.get(userId) ?? null;
      const setup = adminMetricsService.evaluateSetup({
        user,
        stylist,
        services: groupedServices.get(userId) ?? [],
        availability: groupedAvailability.get(userId) ?? [],
        clients: groupedClients.get(userId) ?? [],
        appointments: groupedAppointments.get(userId) ?? [],
        paymentMethods: groupedPaymentMethods.get(userId) ?? [],
        automationSettings: groupedAutomationSettings.get(userId) ?? [],
        productEvents: groupedProductEvents.get(userId) ?? [],
        notificationEvents: groupedNotificationEvents.get(userId) ?? [],
        bookingErrors: groupedBookingErrors.get(userId) ?? []
      });

      const userAppointmentsInRange = (groupedAppointments.get(userId) ?? []).filter((row) => String(row.created_at ?? "") >= range.startIso);
      return {
        userId,
        businessName: getDisplayName(user, stylist),
        planTier: user.plan_tier ?? null,
        planStatus: user.plan_status ?? null,
        signupDate: user.created_at ?? null,
        lastLogin: setup.lastLoginAt,
        lastMeaningfulAction: setup.lastMeaningfulActionAt,
        bookingEnabled: stylist?.booking_enabled === true,
        servicesCount: (groupedServices.get(userId) ?? []).length,
        clientsCount: (groupedClients.get(userId) ?? []).length,
        appointmentsLastRange: userAppointmentsInRange.length,
        publicBookingsLastRange: userAppointmentsInRange.filter((row) => row.booking_source === "public").length,
        automationsSentLastRange: (groupedNotificationEvents.get(userId) ?? []).filter((row) => row.status === "sent").length,
        failuresLastRange: (groupedNotificationEvents.get(userId) ?? []).filter((row) => row.status === "failed").length
          + (groupedBookingErrors.get(userId) ?? []).length,
        setupScore: setup.score,
        health: setup.health
      };
    });
  },

  async getAccountDetail(userId: string, rangeText?: string) {
    const range = createAdminRange(rangeText);
    const inputs = await adminMetricsService.loadMetricInputs(range);
    const user = inputs.users.find((row) => row.id === userId) ?? null;
    const stylist = inputs.stylists.find((row) => row.user_id === userId) ?? null;
    const setup = adminMetricsService.evaluateSetup({
      user: user ?? { id: userId },
      stylist,
      services: inputs.services.filter((row) => row.user_id === userId),
      availability: inputs.availability.filter((row) => row.user_id === userId),
      clients: inputs.clients.filter((row) => row.user_id === userId),
      appointments: inputs.appointments.filter((row) => row.user_id === userId),
      paymentMethods: inputs.paymentMethods.filter((row) => row.user_id === userId),
      automationSettings: inputs.automationSettings.filter((row) => row.user_id === userId),
      productEvents: inputs.productEvents.filter((row) => row.account_user_id === userId),
      notificationEvents: inputs.notificationEvents.filter((row) => row.account_user_id === userId),
      bookingErrors: inputs.bookingErrors.filter((row) => row.account_user_id === userId)
    });
    const [recentAppointments, notes] = await Promise.all([
      loadRecentAccountRows("appointments", userId, "id, client_id, appointment_date, service_name, status, booking_source, price, created_at", 20),
      adminAccountNotesService.listNotes(userId)
    ]);
    const productEvents = sortByCreatedDesc(inputs.productEvents.filter((row) => row.account_user_id === userId)).slice(0, 20);
    const notificationFailures = sortByCreatedDesc(inputs.notificationEvents.filter((row) => row.account_user_id === userId && row.status === "failed")).slice(0, 20);
    const paymentEvents = inputs.productEvents.filter((row) => row.account_user_id === userId);

    return {
      summary: {
        userId,
        email: user?.email ?? null,
        displayName: getDisplayName(user ?? { id: userId }, stylist),
        planTier: user?.plan_tier ?? null,
        planStatus: user?.plan_status ?? null,
        stylistSlug: stylist?.slug ?? null,
        bookingEnabled: stylist?.booking_enabled === true,
        signupDate: user?.created_at ?? null,
        lastLogin: setup.lastLoginAt,
        lastMeaningfulAction: setup.lastMeaningfulActionAt,
        health: setup.health
      },
      setupChecklist: setup.checklist,
      setupScore: setup.score,
      usageTrend: {
        productEvents: inputs.productEvents.filter((row) => row.account_user_id === userId).length,
        appointments: inputs.appointments.filter((row) => row.user_id === userId && String(row.created_at ?? "") >= range.startIso).length,
        clientsAdded: inputs.clients.filter((row) => row.user_id === userId && String(row.created_at ?? "") >= range.startIso).length
      },
      recentAppointments,
      recentEvents: productEvents,
      automationStatus: inputs.automationSettings.filter((row) => row.user_id === userId),
      notificationFailures,
      publicBookingFunnel: {
        pageViews: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "booking_page_viewed").length,
        started: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "public_booking_started").length,
        submitted: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "public_booking_submitted").length,
        failed: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "public_booking_submission_failed").length
      },
      clientsAdded: inputs.clients.filter((row) => row.user_id === userId && String(row.created_at ?? "") >= range.startIso).length,
      paymentShortcutUsage: {
        methodsConfigured: inputs.paymentMethods.filter((row) => row.user_id === userId && row.is_active !== false).length,
        qrShownLast30Days: paymentEvents.filter((row) => row.event_type === "payment_qr_shown").length,
        linkOpenedLast30Days: paymentEvents.filter((row) => row.event_type === "payment_link_opened").length
      },
      referralUsage: {
        linksCreated: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "referral_link_created").length,
        clicks: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "referral_link_clicked").length,
        bookingsSubmitted: inputs.productEvents.filter((row) => row.account_user_id === userId && row.event_type === "referral_booking_submitted").length
      },
      bookingErrors: inputs.bookingErrors.filter((row) => row.account_user_id === userId),
      supportNotes: notes,
      revenue: adminMetricsService.getRevenue(inputs.appointments.filter((row) => row.user_id === userId))
    };
  }
};
