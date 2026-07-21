import {
  calculateAppointmentMetricTotals,
  calculateAverageTicket,
  calculatePercentChange,
  calculateRebookingRate,
  type AppointmentMetricRow
} from "../lib/appointmentMetrics";
import { addDays, getLocalDayOfWeekForDate, getStartOfLocalDayUtc } from "../lib/timezone";
import type { ProfileOverviewMetric, ProfileOverviewPeriod } from "../types/api";
import type { InsightsMetricValue, InsightsSnapshotMetric, InsightsSnapshotPage } from "../validators/insightsValidators";

export type BusinessSnapshotMetricId =
  | "booked_revenue"
  | "appointments_booked"
  | "rebooking_rate"
  | "average_ticket";

export interface BusinessSnapshotAppointment extends AppointmentMetricRow {
  appointment_date: string;
}

export interface BusinessSnapshotPeriodWindow {
  periodLabel: string;
  comparisonLabel: string;
  currentStartIso: string;
  currentEndIso: string;
  previousStartIso: string;
  previousEndIso: string;
  queryStartIso: string;
  queryEndIso: string;
}

export interface BusinessSnapshotMetricDefinition {
  id: BusinessSnapshotMetricId;
  label: string;
  valueKind: InsightsMetricValue["kind"];
  requiredData: readonly ["appointments"];
  /** Availability is separate from a zero value: no appointments is valid data. */
  isAvailable: (input: BusinessSnapshotMetricInput) => boolean;
  calculate: (input: BusinessSnapshotMetricInput) => BusinessSnapshotMetricResult;
  profile: {
    id: string;
    label: string;
    changeKind: "percent" | "number";
  };
}

export interface BusinessSnapshotMetricInput {
  currentAppointments: BusinessSnapshotAppointment[];
  previousAppointments: BusinessSnapshotAppointment[];
  currency: string;
  comparisonLabel: string;
}

export interface BusinessSnapshotMetricResult {
  value: InsightsMetricValue;
  detail: string;
  comparison: {
    label: string;
    percentChange: number | null;
    trend?: "up" | "down" | "neutral";
  };
  currentNumber: number;
  previousNumber: number;
}

export interface BusinessSnapshotPageConfiguration {
  id: string;
  title: string;
  layout: "grid_2x2" | "list";
  periodBehavior: "selected_period";
  metricIds: readonly BusinessSnapshotMetricId[];
  /** Reserved for a later entitlement/configuration source. */
  requiredFeature?: string;
}

/**
 * Version-controlled server configuration. It deliberately selects only
 * registered metric builders—no metric formula is data-configurable.
 */
export const businessSnapshotConfiguration: readonly BusinessSnapshotPageConfiguration[] = [
  {
    id: "business_performance",
    title: "Business Performance",
    layout: "grid_2x2",
    periodBehavior: "selected_period",
    metricIds: ["booked_revenue", "appointments_booked", "rebooking_rate", "average_ticket"]
  }
];

const inWindow = (appointmentDate: string, startIso: string, endIso: string): boolean =>
  appointmentDate >= startIso && appointmentDate < endIso;

const toMinorUnits = (value: number): number => Math.round(value * 100);

const trendFor = (percentChange: number | null): "up" | "down" | "neutral" | undefined => {
  if (percentChange === null) return undefined;
  if (percentChange > 0) return "up";
  if (percentChange < 0) return "down";
  return "neutral";
};

const moneyDetail = (count: number): string =>
  `${count} booked appt${count === 1 ? "" : "s"}`;

const bookedTotals = (appointments: BusinessSnapshotAppointment[]) =>
  calculateAppointmentMetricTotals(appointments, "booked_revenue");

const noAvailabilityGate = (): boolean => true;

export const businessSnapshotMetricCatalog: Readonly<Record<BusinessSnapshotMetricId, BusinessSnapshotMetricDefinition>> = {
  booked_revenue: {
    id: "booked_revenue",
    label: "Booked Revenue",
    valueKind: "money",
    requiredData: ["appointments"],
    isAvailable: noAvailabilityGate,
    calculate: (input) => {
      const current = bookedTotals(input.currentAppointments);
      const previous = bookedTotals(input.previousAppointments);
      const percentChange = calculatePercentChange(current.revenue, previous.revenue);
      return {
        value: { kind: "money", amount_minor: toMinorUnits(current.revenue), currency: input.currency },
        detail: moneyDetail(current.count),
        comparison: { label: input.comparisonLabel, percentChange, trend: trendFor(percentChange) },
        currentNumber: current.revenue,
        previousNumber: previous.revenue
      };
    },
    profile: { id: "revenue", label: "Booked Revenue", changeKind: "percent" }
  },
  appointments_booked: {
    id: "appointments_booked",
    label: "Appts Booked",
    valueKind: "count",
    requiredData: ["appointments"],
    isAvailable: noAvailabilityGate,
    calculate: (input) => {
      const current = bookedTotals(input.currentAppointments);
      const previous = bookedTotals(input.previousAppointments);
      const percentChange = calculatePercentChange(current.count, previous.count);
      return {
        value: { kind: "count", count: current.count },
        detail: "All appointments",
        comparison: { label: input.comparisonLabel, percentChange, trend: trendFor(percentChange) },
        currentNumber: current.count,
        previousNumber: previous.count
      };
    },
    profile: { id: "appointments", label: "Appointments", changeKind: "number" }
  },
  rebooking_rate: {
    id: "rebooking_rate",
    label: "Rebooking Rate",
    valueKind: "percent",
    requiredData: ["appointments"],
    isAvailable: noAvailabilityGate,
    calculate: (input) => {
      const current = calculateRebookingRate(bookedTotals(input.currentAppointments));
      const previous = calculateRebookingRate(bookedTotals(input.previousAppointments));
      const percentChange = calculatePercentChange(current, previous);
      return {
        value: { kind: "percent", percent: current },
        detail: "Returned clients",
        comparison: { label: input.comparisonLabel, percentChange, trend: trendFor(percentChange) },
        currentNumber: current,
        previousNumber: previous
      };
    },
    profile: { id: "rebooking-rate", label: "Rebooking Rate", changeKind: "percent" }
  },
  average_ticket: {
    id: "average_ticket",
    label: "Average Ticket",
    valueKind: "money",
    requiredData: ["appointments"],
    isAvailable: noAvailabilityGate,
    calculate: (input) => {
      const current = calculateAverageTicket(bookedTotals(input.currentAppointments));
      const previous = calculateAverageTicket(bookedTotals(input.previousAppointments));
      const percentChange = calculatePercentChange(current, previous);
      return {
        value: { kind: "money", amount_minor: toMinorUnits(current), currency: input.currency },
        detail: "Booked appts",
        comparison: { label: input.comparisonLabel, percentChange, trend: trendFor(percentChange) },
        currentNumber: current,
        previousNumber: previous
      };
    },
    profile: { id: "avg-ticket", label: "Avg. Ticket", changeKind: "percent" }
  }
};

export const getBusinessSnapshotPeriodWindow = (
  period: ProfileOverviewPeriod,
  todayDate: string,
  timeZone: string
): BusinessSnapshotPeriodWindow => {
  if (period === "month") {
    const currentMonthStartDate = `${todayDate.slice(0, 7)}-01`;
    const [yearText, monthText] = currentMonthStartDate.split("-");
    const monthStart = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, 1));
    const monthDate = (offset: number): string => {
      const shifted = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + offset, 1));
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
    };
    const previousStart = monthDate(-1);
    const currentStart = monthDate(0);
    const currentEnd = monthDate(1);

    return {
      periodLabel: "This Month",
      comparisonLabel: "vs last month",
      currentStartIso: getStartOfLocalDayUtc(currentStart, timeZone).toISOString(),
      currentEndIso: getStartOfLocalDayUtc(currentEnd, timeZone).toISOString(),
      previousStartIso: getStartOfLocalDayUtc(previousStart, timeZone).toISOString(),
      previousEndIso: getStartOfLocalDayUtc(currentStart, timeZone).toISOString(),
      queryStartIso: getStartOfLocalDayUtc(previousStart, timeZone).toISOString(),
      queryEndIso: getStartOfLocalDayUtc(currentEnd, timeZone).toISOString()
    };
  }

  const dayOfWeek = getLocalDayOfWeekForDate(todayDate, timeZone);
  const currentWeekStartDate = addDays(todayDate, -((dayOfWeek + 6) % 7));
  const currentWeekEndDate = addDays(currentWeekStartDate, 7);
  const previousWeekStartDate = addDays(currentWeekStartDate, -7);
  const currentStartIso = getStartOfLocalDayUtc(currentWeekStartDate, timeZone).toISOString();
  const currentEndIso = getStartOfLocalDayUtc(currentWeekEndDate, timeZone).toISOString();
  const previousStartIso = getStartOfLocalDayUtc(previousWeekStartDate, timeZone).toISOString();

  return {
    periodLabel: "This Week",
    comparisonLabel: "vs last week",
    currentStartIso,
    currentEndIso,
    previousStartIso,
    previousEndIso: currentStartIso,
    queryStartIso: previousStartIso,
    queryEndIso: currentEndIso
  };
};

export const evaluateBusinessSnapshotMetrics = (input: {
  appointments: BusinessSnapshotAppointment[];
  periodWindow: BusinessSnapshotPeriodWindow;
  currency?: string;
}): Map<BusinessSnapshotMetricId, BusinessSnapshotMetricResult> => {
  const currentAppointments = input.appointments.filter((appointment) =>
    inWindow(appointment.appointment_date, input.periodWindow.currentStartIso, input.periodWindow.currentEndIso)
  );
  const previousAppointments = input.appointments.filter((appointment) =>
    inWindow(appointment.appointment_date, input.periodWindow.previousStartIso, input.periodWindow.previousEndIso)
  );
  const metricInput: BusinessSnapshotMetricInput = {
    currentAppointments,
    previousAppointments,
    currency: input.currency ?? "USD",
    comparisonLabel: input.periodWindow.comparisonLabel
  };

  return new Map(
    (Object.values(businessSnapshotMetricCatalog) as BusinessSnapshotMetricDefinition[])
      .filter((definition) => definition.isAvailable(metricInput))
      .map((definition) => [definition.id, definition.calculate(metricInput)])
  );
};

export const buildBusinessSnapshotPages = (input: {
  appointments: BusinessSnapshotAppointment[];
  periodWindow: BusinessSnapshotPeriodWindow;
  currency?: string;
  configuration?: readonly BusinessSnapshotPageConfiguration[];
  enabledFeatures?: ReadonlySet<string>;
}): InsightsSnapshotPage[] => {
  const results = evaluateBusinessSnapshotMetrics(input);
  const configuration = input.configuration ?? businessSnapshotConfiguration;

  return configuration
    .filter((page) => !page.requiredFeature || input.enabledFeatures?.has(page.requiredFeature) === true)
    .map((page) => ({
    id: page.id,
    title: page.title,
    period_label: input.periodWindow.periodLabel,
    layout: page.layout,
    window: {
      start_at: input.periodWindow.currentStartIso,
      end_at: input.periodWindow.currentEndIso
    },
    metrics: page.metricIds.flatMap((metricId): InsightsSnapshotMetric[] => {
      const definition = businessSnapshotMetricCatalog[metricId];
      const result = results.get(metricId);
      if (!definition || !result) return [];

      return [{
        id: definition.id,
        label: definition.label,
        value: result.value,
        detail: result.detail,
        comparison: {
          label: result.comparison.label,
          percent_change: result.comparison.percentChange,
          ...(result.comparison.trend ? { trend: result.comparison.trend } : {})
        }
      }];
    })
    }));
};

const legacyFormatCurrency = (value: number): string => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(value);

const legacyFormatPercentChange = (current: number, previous: number): string => {
  if (previous === 0) return current === 0 ? "0%" : "↑ 100%";
  const deltaPercent = Math.round(((current - previous) / previous) * 100);
  return deltaPercent === 0 ? "0%" : `${deltaPercent > 0 ? "↑" : "↓"} ${Math.abs(deltaPercent)}%`;
};

const legacyFormatNumberChange = (current: number, previous: number): string => {
  const delta = current - previous;
  return delta === 0 ? "0" : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)}`;
};

/** Maps the catalog back to Profile Overview's existing display-string contract. */
export const buildProfileOverviewPerformanceMetrics = (input: {
  appointments: BusinessSnapshotAppointment[];
  periodWindow: BusinessSnapshotPeriodWindow;
  currency?: string;
}): ProfileOverviewMetric[] => {
  const results = evaluateBusinessSnapshotMetrics(input);

  return (Object.values(businessSnapshotMetricCatalog) as BusinessSnapshotMetricDefinition[]).flatMap((definition) => {
    const result = results.get(definition.id);
    if (!result) return [];
    const value = result.value.kind === "money"
      ? legacyFormatCurrency(result.currentNumber)
      : result.value.kind === "percent"
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(result.currentNumber)}%`
      : String(result.currentNumber);
    const change = definition.profile.changeKind === "number"
      ? legacyFormatNumberChange(result.currentNumber, result.previousNumber)
      : legacyFormatPercentChange(result.currentNumber, result.previousNumber);

    return [{
      id: definition.profile.id,
      label: definition.profile.label,
      value,
      change,
      detail: input.periodWindow.comparisonLabel
    }];
  });
};
