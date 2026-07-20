import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBusinessSnapshotPages,
  buildProfileOverviewPerformanceMetrics,
  businessSnapshotConfiguration,
  getBusinessSnapshotPeriodWindow,
  type BusinessSnapshotAppointment,
  type BusinessSnapshotPeriodWindow
} from "../services/insightsSnapshotService";

const window: BusinessSnapshotPeriodWindow = {
  periodLabel: "This Week",
  comparisonLabel: "vs last week",
  previousStartIso: "2026-07-06T00:00:00.000Z",
  previousEndIso: "2026-07-13T00:00:00.000Z",
  currentStartIso: "2026-07-13T00:00:00.000Z",
  currentEndIso: "2026-07-20T00:00:00.000Z",
  queryStartIso: "2026-07-06T00:00:00.000Z",
  queryEndIso: "2026-07-20T00:00:00.000Z"
};

const appointments: BusinessSnapshotAppointment[] = [
  { appointment_date: "2026-07-14T12:00:00.000Z", status: "completed", price: 100, client_id: "client-a" },
  { appointment_date: "2026-07-15T12:00:00.000Z", status: "scheduled", price: 50, client_id: "client-a" },
  { appointment_date: "2026-07-16T12:00:00.000Z", status: "no_show", price: 400, client_id: "client-b" },
  { appointment_date: "2026-07-08T12:00:00.000Z", status: "completed", price: 100, client_id: "client-c" }
];

describe("Insights snapshot metric catalog", () => {
  it("builds ordered, server-configured pages from structured metric values", () => {
    const pages = buildBusinessSnapshotPages({ appointments, periodWindow: window });

    assert.deepEqual(pages.map((page) => page.id), businessSnapshotConfiguration.map((page) => page.id));
    assert.deepEqual(pages[0].metrics.map((metric) => metric.id), [
      "booked_revenue", "appointments_booked", "rebooking_rate", "average_ticket"
    ]);
    assert.deepEqual(pages[0].metrics[0].value, {
      kind: "money", amount_minor: 15000, currency: "USD"
    });
    assert.equal(pages[0].metrics[1].value.kind, "count");
    assert.equal(pages[0].metrics[1].value.count, 2);
    assert.deepEqual(pages[0].metrics[0].comparison, {
      label: "vs last week", percent_change: 50, trend: "up"
    });
  });

  it("uses null comparison values instead of fabricating a trend", () => {
    const pages = buildBusinessSnapshotPages({
      appointments: appointments.filter((appointment) => appointment.appointment_date >= window.currentStartIso),
      periodWindow: window
    });

    assert.deepEqual(pages[0].metrics[0].comparison, {
      label: "vs last week", percent_change: null
    });
  });

  it("maps catalog results to the unchanged Profile Overview display contract", () => {
    assert.deepEqual(buildProfileOverviewPerformanceMetrics({ appointments, periodWindow: window }), [
      { id: "revenue", label: "Booked Revenue", value: "$150", change: "↑ 50%", detail: "vs last week" },
      { id: "appointments", label: "Appointments", value: "2", change: "↑ 1", detail: "vs last week" },
      { id: "rebooking-rate", label: "Rebooking Rate", value: "100%", change: "↑ 100%", detail: "vs last week" },
      { id: "avg-ticket", label: "Avg. Ticket", value: "$75", change: "↓ 25%", detail: "vs last week" }
    ]);
  });

  it("uses business-local Monday week boundaries", () => {
    const period = getBusinessSnapshotPeriodWindow("week", "2026-07-15", "America/Denver");
    assert.equal(period.currentStartIso, "2026-07-13T06:00:00.000Z");
    assert.equal(period.currentEndIso, "2026-07-20T06:00:00.000Z");
    assert.equal(period.previousEndIso, period.currentStartIso);
  });
});
