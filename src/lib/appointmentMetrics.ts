import type { AppointmentStatus } from "../types/api";

export type AppointmentMetricType =
  | "booked_revenue"
  | "earned_revenue"
  | "upcoming_revenue"
  | "booked_minutes"
  | "busy_time";

export interface AppointmentMetricRow {
  status?: unknown;
  price?: unknown;
  revenue?: unknown;
  duration_minutes?: unknown;
  client_id?: unknown;
}

export interface AppointmentMetricTotals {
  revenue: number;
  minutes: number;
  count: number;
  perClientCounts: Map<string, number>;
}

const bookedRevenueStatuses = new Set<AppointmentStatus>(["pending", "scheduled", "completed"]);
const earnedRevenueStatuses = new Set<AppointmentStatus>(["completed"]);
const upcomingRevenueStatuses = new Set<AppointmentStatus>(["pending", "scheduled"]);
const bookedMinutesStatuses = new Set<AppointmentStatus>(["pending", "scheduled", "completed"]);
const busyTimeStatuses = new Set<AppointmentStatus>(["pending", "scheduled", "completed"]);

const statusSets: Record<AppointmentMetricType, Set<AppointmentStatus>> = {
  booked_revenue: bookedRevenueStatuses,
  earned_revenue: earnedRevenueStatuses,
  upcoming_revenue: upcomingRevenueStatuses,
  booked_minutes: bookedMinutesStatuses,
  busy_time: busyTimeStatuses
};

export const toMetricNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getAppointmentValue = (appointment: AppointmentMetricRow): number =>
  toMetricNumber(appointment.revenue ?? appointment.price);

export const getAppointmentDurationMinutes = (appointment: AppointmentMetricRow): number =>
  toMetricNumber(appointment.duration_minutes);

export const isAppointmentIncludedInMetric = (
  appointment: AppointmentMetricRow,
  metricType: AppointmentMetricType
): boolean =>
  statusSets[metricType].has(appointment.status as AppointmentStatus);

export const createAppointmentMetricTotals = (): AppointmentMetricTotals => ({
  revenue: 0,
  minutes: 0,
  count: 0,
  perClientCounts: new Map()
});

export const addAppointmentToMetricTotals = (
  totals: AppointmentMetricTotals,
  appointment: AppointmentMetricRow,
  metricType: AppointmentMetricType
): AppointmentMetricTotals => {
  if (!isAppointmentIncludedInMetric(appointment, metricType)) {
    return totals;
  }

  totals.revenue += getAppointmentValue(appointment);
  totals.minutes += getAppointmentDurationMinutes(appointment);
  totals.count += 1;

  if (typeof appointment.client_id === "string") {
    totals.perClientCounts.set(
      appointment.client_id,
      (totals.perClientCounts.get(appointment.client_id) ?? 0) + 1
    );
  }

  return totals;
};

export const calculateAppointmentMetricTotals = (
  appointments: AppointmentMetricRow[],
  metricType: AppointmentMetricType
): AppointmentMetricTotals =>
  appointments.reduce(
    (totals, appointment) => addAppointmentToMetricTotals(totals, appointment, metricType),
    createAppointmentMetricTotals()
  );

export const calculateAverageTicket = (totals: AppointmentMetricTotals): number =>
  totals.count === 0 ? 0 : totals.revenue / totals.count;

export const calculateRebookingRate = (totals: AppointmentMetricTotals): number => {
  const totalClients = totals.perClientCounts.size;

  if (totalClients === 0) {
    return 0;
  }

  const rebookedClients = [...totals.perClientCounts.values()].filter((count) => count > 1).length;
  return Math.round((rebookedClients / totalClients) * 100);
};

export const calculatePercentChange = (current: number, previous: number): number | null => {
  if (previous === 0) {
    return null;
  }

  return Math.round(((current - previous) / previous) * 100);
};

export const toCents = (value: number): number => Math.round(value * 100);

