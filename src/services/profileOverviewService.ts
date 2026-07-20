import {
  addDays,
  formatDateInTimeZone,
  getCurrentLocalDate,
  getLocalDateForInstant,
  getEndOfLocalDayUtc,
  getStartOfLocalDayUtc
} from "../lib/timezone";
import {
  getAppointmentValue,
  isAppointmentIncludedInMetric
} from "../lib/appointmentMetrics";
import { supabaseAdmin } from "../lib/supabase";
import type {
  BookingSettings,
  ProfileOverviewChartBar,
  ProfileOverviewPeriod,
  ProfileOverviewResponse,
  ServiceCatalogItem
} from "../types/api";
import { mapAvailabilityRowsToSettings } from "./availabilityService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { bookingRulesService } from "./bookingRulesService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";
import { usersService } from "./usersService";
import {
  buildProfileOverviewPerformanceMetrics,
  getBusinessSnapshotPeriodWindow,
  type BusinessSnapshotAppointment
} from "./insightsSnapshotService";

interface AppointmentRow extends Row, BusinessSnapshotAppointment {
  appointment_date: string;
  price: number | string;
  client_id: string | null;
  status: string;
}

interface AvailabilityRow extends Row {
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
  client_audience?: "all" | "new" | "returning" | null;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatCurrency = (value: number): string => currencyFormatter.format(value);

const formatPercentChange = (current: number, previous: number): string => {
  if (previous === 0) return current === 0 ? "0%" : "↑ 100%";
  const deltaPercent = Math.round(((current - previous) / previous) * 100);
  return deltaPercent === 0 ? "0%" : `${deltaPercent > 0 ? "↑" : "↓"} ${Math.abs(deltaPercent)}%`;
};

const formatMinutes = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) {
    return `${remainingMinutes}m`;
  }

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
};

const formatTimeOfDay = (time: string): string => {
  const [rawHours, rawMinutes] = time.split(":");
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  const period = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 || 12;
  return `${twelveHour}:${String(minutes).padStart(2, "0")} ${period}`;
};

const formatHoursRange = (startTime: string, endTime: string): string =>
  `${formatTimeOfDay(startTime)} - ${formatTimeOfDay(endTime)}`;

const formatDayRange = (startDay: number, endDay: number): string =>
  startDay === endDay ? dayLabels[startDay] : `${dayLabels[startDay]} - ${dayLabels[endDay]}`;


const getTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const getDisplayName = (user: Row | null): string => {
  const businessName = typeof user?.business_name === "string" ? user.business_name.trim() : "";
  const fullName = typeof user?.full_name === "string" ? user.full_name.trim() : "";
  const email = typeof user?.email === "string" ? user.email : "";

  return fullName || businessName || email || "Your Profile";
};

const getLocationLabel = (user: Row | null): string => {
  return typeof user?.location_label === "string" ? user.location_label.trim() : "";
};

const getPlanTier = (user: Row | null): string | null => {
  const planTier = typeof user?.plan_tier === "string" ? user.plan_tier.trim().toLowerCase() : "";
  return planTier || null;
};

const getPlanLabel = (user: Row | null): string => {
  const planTier = getPlanTier(user);

  if (!planTier) {
    return "";
  }

  if (planTier === "basic") {
    return "Basic";
  }

  if (planTier === "pro") {
    return "Pro";
  }

  if (planTier === "premium") {
    return "Premium";
  }

  return planTier.charAt(0).toUpperCase() + planTier.slice(1);
};

const getAvatarImageId = (user: Row | null): string | null => {
  return typeof user?.avatar_image_id === "string" ? user.avatar_image_id : null;
};

const isWithinRange = (instant: string, startIso: string, endIso: string): boolean =>
  instant >= startIso && instant < endIso;

const buildBookingRulesSummary = (settings: BookingSettings): { badge: string; detail: string; items: string[] } => {
  const items = [
    `${settings.cancellationWindowHours}-hour cancellation window`,
    `${settings.leadTimeHours}-hour minimum lead time for online booking`,
    `Max booking window: ${settings.maxBookingWindowDays} days`,
    settings.newClientApprovalRequired
      ? "New clients require approval before booking"
      : "New clients can book without approval"
  ];

  if (settings.restrictServicesForNewClients && settings.restrictedServiceIds.length > 0) {
    items.push(`New clients are restricted from ${settings.restrictedServiceIds.length} service(s)`);
  }

  return {
    badge: `${items.length} rules set`,
    detail: [
      `Lead time: ${settings.leadTimeHours}h`,
      `Cancel window: ${settings.cancellationWindowHours}h`,
      `Max booking: ${settings.maxBookingWindowDays} days`,
      settings.newClientApprovalRequired ? "New client: Approval" : "New client: Open booking"
    ].join(" • "),
    items
  };
};

const buildAvailabilitySummary = (availability: AvailabilityRow[]): ProfileOverviewResponse["availability"] => {
  const activeRows = availability
    .filter((row) => row.is_active)
    .sort((left, right) => left.day_of_week - right.day_of_week || left.start_time.localeCompare(right.start_time));

  if (activeRows.length === 0) {
    return [];
  }

  const perDay = new Map<number, Set<string>>();

  for (const row of activeRows) {
    const dayHours = perDay.get(row.day_of_week) ?? new Set<string>();
    dayHours.add(formatHoursRange(row.start_time, row.end_time));
    perDay.set(row.day_of_week, dayHours);
  }

  const orderedDays = [...perDay.entries()].sort(([left], [right]) => left - right);
  const groups: Array<{ startDay: number; endDay: number; hours: string }> = [];

  for (const [day, hoursList] of orderedDays) {
    const hours = [...hoursList].join(", ");
    const previous = groups[groups.length - 1];

    if (previous && previous.endDay + 1 === day && previous.hours === hours) {
      previous.endDay = day;
      continue;
    }

    groups.push({ startDay: day, endDay: day, hours });
  }

  return groups.map((group) => ({
    day: formatDayRange(group.startDay, group.endDay),
    hours: group.hours
  }));
};

const buildChartBars = (chartPoints: ProfileOverviewResponse["chartPoints"]): ProfileOverviewChartBar[] => {
  const maxRevenue = Math.max(...chartPoints.map((point) => point.revenue), 0);

  return chartPoints.map((point, index) => ({
    label: point.label,
    value: maxRevenue === 0 ? 0 : Math.max(8, Math.round((point.revenue / maxRevenue) * 100)),
    highlighted: index === chartPoints.length - 1
  }));
};

const buildServicesSummary = (services: ServiceCatalogItem[]) => ({
  badge: `${services.length} service${services.length === 1 ? "" : "s"}`,
  detail: services.length > 0 ? "Manage your services, pricing, and durations" : "Add services with pricing and durations"
});

const buildMessagingSummary = () => ({
  badge: "Not configured",
  detail: "Messaging settings are not configured yet"
});

export const profileOverviewService = {
  async getOverview(userId: string, performancePeriod: ProfileOverviewPeriod = "week"): Promise<ProfileOverviewResponse> {
    const [user, stylist, bookingSettings, services, timeZone] = await Promise.all([
      usersService.getById(userId),
      stylistsService.getByUserId(userId),
      bookingRulesService.getByUserId(userId),
      servicesService.listByUserId(userId),
      businessTimeZoneService.getForUser(userId)
    ]);

    const todayDate = getCurrentLocalDate(timeZone);
    const nowIso = new Date().toISOString();
    const nextWeekEndIso = getStartOfLocalDayUtc(addDays(todayDate, 7), timeZone).toISOString();
    const nextMonthEndIso = getStartOfLocalDayUtc(addDays(todayDate, 30), timeZone).toISOString();
    const previousThirtyDaysStartIso = getStartOfLocalDayUtc(addDays(todayDate, -30), timeZone).toISOString();
    const performanceWindows = getBusinessSnapshotPeriodWindow(performancePeriod, todayDate, timeZone);
    const appointmentsQueryStartIso =
      previousThirtyDaysStartIso < performanceWindows.queryStartIso ? previousThirtyDaysStartIso : performanceWindows.queryStartIso;
    const appointmentsQueryEndIso =
      nextMonthEndIso > performanceWindows.queryEndIso ? nextMonthEndIso : performanceWindows.queryEndIso;
    const chartDateKeys = Array.from({ length: 7 }, (_, index) => addDays(todayDate, index));
    const chartPointMap = new Map(
      chartDateKeys.map((dateText) => [
        dateText,
        {
          label: formatDateInTimeZone(getStartOfLocalDayUtc(dateText, timeZone), timeZone, { weekday: "narrow" }),
          revenue: 0,
          appointments: 0
        }
      ])
    );

    const [appointmentsResult, availabilityResult] = await Promise.all([
      supabaseAdmin
        .from("appointments")
        .select("appointment_date, price, client_id, status")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .gte("appointment_date", appointmentsQueryStartIso)
        .lt("appointment_date", appointmentsQueryEndIso)
        .order("appointment_date", { ascending: true }),
      supabaseAdmin
        .from("availability")
        .select("day_of_week, start_time, end_time, is_active")
        .eq("user_id", userId)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true })
    ]);

    handleSupabaseError(appointmentsResult.error, "Unable to load profile overview appointments");
    handleSupabaseError(availabilityResult.error, "Unable to load profile overview availability");

    const appointments = (appointmentsResult.data ?? []) as AppointmentRow[];
    let nextWeekRevenue = 0;
    let nextMonthRevenue = 0;
    let nextMonthAppointmentCount = 0;
    let previousThirtyDaysRevenue = 0;

    for (const appointment of appointments) {
      const appointmentDate = appointment.appointment_date;
      const price = getAppointmentValue(appointment);

      if (appointmentDate >= nowIso && isAppointmentIncludedInMetric(appointment, "upcoming_revenue")) {
        if (appointmentDate < nextWeekEndIso) {
          nextWeekRevenue += price;
        }

        if (appointmentDate < nextMonthEndIso) {
          nextMonthRevenue += price;
          nextMonthAppointmentCount += 1;
        }

        const localDate = getLocalDateForInstant(appointmentDate, timeZone);
        const chartPoint = chartPointMap.get(localDate);

        if (chartPoint) {
          chartPoint.revenue += price;
          chartPoint.appointments += 1;
        }
      }

      if (
        isWithinRange(appointmentDate, previousThirtyDaysStartIso, nowIso)
        && isAppointmentIncludedInMetric(appointment, "booked_revenue")
      ) {
        previousThirtyDaysRevenue += price;
      }

    }

    const nextSevenChartPoints = chartDateKeys.map((dateText) => chartPointMap.get(dateText) ?? {
      label: formatDateInTimeZone(getStartOfLocalDayUtc(dateText, timeZone), timeZone, { weekday: "narrow" }),
      revenue: 0,
      appointments: 0
    });
    const chartBars = buildChartBars(nextSevenChartPoints);
    const upcomingRevenueTrend = formatPercentChange(nextMonthRevenue, previousThirtyDaysRevenue);
    const bookingSummary = buildBookingRulesSummary(bookingSettings);
    const servicesSummary = buildServicesSummary(services);
    const messagingSummary = buildMessagingSummary();
    const availabilityRows = (availabilityResult.data ?? []) as AvailabilityRow[];
    const availability = buildAvailabilitySummary(availabilityRows);
    const availabilitySettings = mapAvailabilityRowsToSettings(availabilityRows, timeZone);
    const performanceMetrics = buildProfileOverviewPerformanceMetrics({
      appointments,
      periodWindow: performanceWindows
    });

    return {
      avatarImageId: getAvatarImageId(user),
      profile: {
        displayName: getDisplayName(user),
        fullName: getTrimmedString(user?.full_name),
        businessName: getTrimmedString(user?.business_name),
        bookingDisplayName: getTrimmedString(stylist?.display_name),
        planLabel: getPlanLabel(user),
        locationLabel: getLocationLabel(user)
      },
      hero: {
        title: "Upcoming Revenue",
        rangeLabel: "Next 30 Days",
        value: formatCurrency(nextMonthRevenue),
        appointmentCount: nextMonthAppointmentCount,
        appointmentCountLabel: `from ${nextMonthAppointmentCount} future appointment${nextMonthAppointmentCount === 1 ? "" : "s"}`,
        trendLabel: upcomingRevenueTrend,
        comparisonLabel: "vs last 30 days",
        chartBars
      },
      performance: {
        period: performancePeriod,
        periodLabel: performanceWindows.periodLabel,
        metrics: performanceMetrics
      },
      availability,
      availabilitySettings,
      settingsSummary: {
        booking: bookingSummary,
        services: servicesSummary,
        messaging: messagingSummary,
        business: {
          detail: "Location, contact info, and business details"
        },
        account: {
          detail: "Billing, subscription, and logout"
        }
      },
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        duration: formatMinutes(service.durationMinutes),
        price: formatCurrency(service.price)
      })),
      bookingRules: bookingSummary.items,
      messagingSettings: [],
      metrics: performanceMetrics,
      revenueForecast: {
        nextWeek: formatCurrency(nextWeekRevenue),
        nextMonth: formatCurrency(nextMonthRevenue)
      },
      chartPoints: nextSevenChartPoints
    };
  }
};
