import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { insightsService } = require("../services/insightsService") as typeof import("../services/insightsService");

const userId = "11111111-1111-1111-1111-111111111111";
const configurationId = "20260720-0000-4000-8000-000000000001";
const now = new Date("2026-07-15T18:00:00.000Z");

const runtimeConfiguration = (pages?: unknown[]) => ({
  id: configurationId,
  configuration_version: 2,
  is_active: true,
  enabled: true,
  pages: pages ?? [{
    id: "business_performance",
    title: "Business Performance",
    layout: "grid_2x2",
    period_behavior: "selected_period",
    enabled: true,
    metrics: [
      { metric_id: "booked_revenue", enabled: true },
      { metric_id: "appointments_booked", enabled: true },
      { metric_id: "rebooking_rate", enabled: true },
      { metric_id: "average_ticket", enabled: true }
    ]
  }],
  target_plan_tiers: null,
  rollout_percentage: 100,
  updated_by: "admin@example.com",
  updated_at: now.toISOString()
});

const user = { id: userId, email: "owner@example.com", timezone: "America/Denver", plan_tier: "pro" };

const getInsights = () => insightsService.getForUser(userId, {
  business_snapshot_period: "week",
  referral_period: "this_month"
}, now);

describe("Insights business snapshot endpoint service", () => {
  it("returns configured server-driven metrics using account-local week boundaries", async () => {
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      appointments: [
        { user_id: userId, appointment_date: "2026-07-13T05:59:59.000Z", status: "completed", price: 999, client_id: "client-before-window" },
        { user_id: userId, appointment_date: "2026-07-13T06:00:00.000Z", status: "completed", price: 100, client_id: "client-a" },
        { user_id: userId, appointment_date: "2026-07-14T18:00:00.000Z", status: "scheduled", price: 50, client_id: "client-a" },
        { user_id: userId, appointment_date: "2026-07-15T18:00:00.000Z", status: "no_show", price: 400, client_id: "client-b" },
        { user_id: userId, appointment_date: "2026-07-15T18:00:00.000Z", status: "cancelled", price: 500, client_id: "client-c" },
        { user_id: userId, appointment_date: "2026-07-08T18:00:00.000Z", status: "completed", price: 100, client_id: "client-d" }
      ]
    });
    try {
      const response = await getInsights();
      const snapshot = response.business_snapshot;
      assert.equal(snapshot.available, true);
      if (!snapshot.available) throw new Error("Expected available snapshot");

      assert.equal(response.account_timezone, "America/Denver");
      assert.deepEqual(snapshot.pages[0].window, {
        start_at: "2026-07-13T06:00:00.000Z",
        end_at: "2026-07-20T06:00:00.000Z"
      });
      assert.deepEqual(snapshot.pages[0].metrics[0].value, {
        kind: "money", amount_minor: 15000, currency: "USD"
      });
      assert.equal(snapshot.pages[0].metrics[1].value.kind, "count");
      assert.equal(snapshot.pages[0].metrics[1].value.count, 2);
      assert.deepEqual(snapshot.pages[0].metrics[0].comparison, {
        // The instant one second before the Denver-local Monday boundary is
        // correctly counted in the preceding week, never the current one.
        label: "vs last week", percent_change: -86, trend: "down"
      });
      assert.equal(response.campaigns.available, true);
      if (!response.campaigns.available) throw new Error("Expected available campaigns");
      assert.equal(response.campaigns.campaign_count, 0);
      assert.deepEqual(response.campaigns.unavailable_metrics, [{
        id: "clients_returned",
        reason: "not_implemented",
        message: "Clients returned is not available yet."
      }]);
    } finally {
      supabase.restore();
    }
  });

  it("returns a calculated zero-value snapshot for an empty account", async () => {
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      appointments: []
    });
    try {
      const response = await getInsights();
      assert.equal(response.business_snapshot.available, true);
      if (!response.business_snapshot.available) throw new Error("Expected available snapshot");
      assert.deepEqual(response.business_snapshot.pages[0].metrics[0].value, {
        kind: "money", amount_minor: 0, currency: "USD"
      });
      assert.deepEqual(response.business_snapshot.pages[0].metrics[0].comparison, {
        label: "vs last week", percent_change: null
      });
    } finally {
      supabase.restore();
    }
  });

  it("does not invent a comparison when only the current period has history", async () => {
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      appointments: [{ user_id: userId, appointment_date: "2026-07-14T18:00:00.000Z", status: "completed", price: 100, client_id: "client-a" }]
    });
    try {
      const response = await getInsights();
      if (!response.business_snapshot.available) throw new Error("Expected available snapshot");
      assert.deepEqual(response.business_snapshot.pages[0].metrics[0].comparison, {
        label: "vs last week", percent_change: null
      });
    } finally {
      supabase.restore();
    }
  });

  it("uses a changed runtime configuration without changing API code", async () => {
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration([{
        id: "single_metric",
        title: "Appointments",
        layout: "list",
        period_behavior: "selected_period",
        enabled: true,
        metrics: [{ metric_id: "appointments_booked", enabled: true }]
      }])],
      appointments: [{ user_id: userId, appointment_date: "2026-07-14T18:00:00.000Z", status: "completed", price: 100, client_id: "client-a" }]
    });
    try {
      const response = await getInsights();
      if (!response.business_snapshot.available) throw new Error("Expected available snapshot");
      assert.deepEqual(response.business_snapshot.pages.map((page) => ({
        id: page.id,
        layout: page.layout,
        metrics: page.metrics.map((metric) => metric.id)
      })), [{ id: "single_metric", layout: "list", metrics: ["appointments_booked"] }]);
    } finally {
      supabase.restore();
    }
  });

  it("returns exact canonical appointment-event counts for contiguous 24-hour windows", async () => {
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      appointments: [],
      activity_events: [
        { id: "10000000-0000-4000-8000-000000000001", user_id: userId, activity_type: "booking_created", dedupe_key: "booking-current-1", occurred_at: "2026-07-14T18:00:00.000Z" },
        { id: "10000000-0000-4000-8000-000000000002", user_id: userId, activity_type: "booking_created", dedupe_key: "booking-current-2", occurred_at: "2026-07-15T17:59:59.000Z" },
        { id: "10000000-0000-4000-8000-000000000003", user_id: userId, activity_type: "booking_created", dedupe_key: "booking-previous", occurred_at: "2026-07-14T17:59:59.000Z" },
        { id: "10000000-0000-4000-8000-000000000004", user_id: userId, activity_type: "appointment_cancelled", dedupe_key: "cancel-current", occurred_at: "2026-07-15T12:00:00.000Z" },
        { id: "10000000-0000-4000-8000-000000000005", user_id: userId, activity_type: "appointment_cancelled", dedupe_key: "cancel-previous-1", occurred_at: "2026-07-14T12:00:00.000Z" },
        { id: "10000000-0000-4000-8000-000000000006", user_id: userId, activity_type: "appointment_cancelled", dedupe_key: "cancel-previous-2", occurred_at: "2026-07-13T18:00:00.000Z" }
      ]
    });
    try {
      const response = await getInsights();
      assert.equal(response.appointment_changes.available, true);
      if (!response.appointment_changes.available) throw new Error("Expected available appointment changes");
      assert.deepEqual(response.appointment_changes.window, {
        label: "Last 24 hours",
        current_start_at: "2026-07-14T18:00:00.000Z",
        current_end_at: "2026-07-15T18:00:00.000Z",
        previous_start_at: "2026-07-13T18:00:00.000Z",
        previous_end_at: "2026-07-14T18:00:00.000Z"
      });
      assert.deepEqual(response.appointment_changes.new_appointments, {
        current_count: 2, previous_count: 1, percent_change: 100
      });
      assert.deepEqual(response.appointment_changes.cancellations, {
        current_count: 1, previous_count: 2, percent_change: -50
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns truthful referral month-to-date and all-time aggregates with minor-unit money", async () => {
    const referrerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      activity_events: [],
      client_referral_links: [
        { id: "20000000-0000-4000-8000-000000000001", user_id: userId, created_at: "2026-07-02T12:00:00.000Z" },
        { id: "20000000-0000-4000-8000-000000000002", user_id: userId, created_at: "2026-06-02T12:00:00.000Z" }
      ],
      referral_events: [
        { id: "30000000-0000-4000-8000-000000000001", user_id: userId, event_type: "opened", created_at: "2026-07-03T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000002", user_id: userId, event_type: "opened", created_at: "2026-07-04T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000003", user_id: userId, event_type: "opened", created_at: "2026-06-03T12:00:00.000Z" }
      ],
      clients: [
        { id: referrerId, user_id: userId, first_name: "Sarah", last_name: "Jones", preferred_name: null },
        { id: "40000000-0000-4000-8000-000000000001", user_id: userId, original_referred_by_client_id: referrerId, original_referral_attributed_at: "2026-07-05T12:00:00.000Z" },
        { id: "40000000-0000-4000-8000-000000000002", user_id: userId, original_referred_by_client_id: referrerId, original_referral_attributed_at: "2026-06-05T12:00:00.000Z" }
      ],
      appointments: [
        { id: "50000000-0000-4000-8000-000000000001", user_id: userId, client_id: "40000000-0000-4000-8000-000000000001", referred_by_client_id: referrerId, referral_attributed_at: "2026-07-06T12:00:00.000Z", status: "completed", price: 100 },
        { id: "50000000-0000-4000-8000-000000000002", user_id: userId, client_id: "40000000-0000-4000-8000-000000000001", referred_by_client_id: referrerId, referral_attributed_at: "2026-07-07T12:00:00.000Z", status: "scheduled", price: 50 },
        { id: "50000000-0000-4000-8000-000000000003", user_id: userId, client_id: "40000000-0000-4000-8000-000000000001", referred_by_client_id: referrerId, referral_attributed_at: "2026-07-08T12:00:00.000Z", status: "cancelled", price: 30 },
        { id: "50000000-0000-4000-8000-000000000004", user_id: userId, client_id: "40000000-0000-4000-800000000002", referred_by_client_id: referrerId, referral_attributed_at: "2026-06-08T12:00:00.000Z", status: "completed", price: 200 }
      ]
    });
    try {
      const month = await getInsights();
      assert.equal(month.referrals.available, true);
      if (!month.referrals.available) throw new Error("Expected available referrals");
      assert.equal(month.referrals.period.label, "This Month");
      assert.equal(month.referrals.appointments_booked, 2);
      assert.equal(month.referrals.conversion_rate_percent, 100);
      assert.deepEqual(month.referrals.attributed_revenue, { kind: "money", amount_minor: 10000, currency: "USD" });
      assert.deepEqual(month.referrals.booked_value, { kind: "money", amount_minor: 15000, currency: "USD" });
      assert.deepEqual(month.referrals.top_referrer, { client_id: referrerId, display_name: "Sarah Jones", referral_count: 2 });

      const allTime = await insightsService.getForUser(userId, {
        business_snapshot_period: "week",
        referral_period: "all_time"
      }, now);
      assert.equal(allTime.referrals.available, true);
      if (!allTime.referrals.available) throw new Error("Expected available referrals");
      assert.equal(allTime.referrals.period.label, "All Time");
      assert.equal(allTime.referrals.new_clients, 2);
      assert.equal(allTime.referrals.appointments_booked, 3);
      assert.equal(allTime.referrals.links_sent, 2);
      assert.equal(allTime.referrals.links_clicked, 3);
      assert.deepEqual(allTime.referrals.attributed_revenue, { kind: "money", amount_minor: 30000, currency: "USD" });
      assert.deepEqual(allTime.referrals.booked_value, { kind: "money", amount_minor: 35000, currency: "USD" });
    } finally {
      supabase.restore();
    }
  });

  it("returns period campaign totals, canonical active statuses, and a drill-down-safe top campaign", async () => {
    const firstCampaignId = "60000000-0000-4000-8000-000000000001";
    const secondCampaignId = "60000000-0000-4000-8000-000000000002";
    const supabase = installMockSupabase({
      users: [user],
      insight_snapshot_configurations: [runtimeConfiguration()],
      activity_events: [],
      campaigns: [
        { id: firstCampaignId, user_id: userId, name: "Scheduled Refresh", status: "scheduled" },
        { id: secondCampaignId, user_id: userId, name: "Summer Refresh", status: "completed" },
        { id: "60000000-0000-4000-8000-000000000003", user_id: userId, name: "Cancelled", status: "cancelled" }
      ],
      campaign_recipients: [
        { id: "70000000-0000-4000-8000-000000000001", user_id: userId, campaign_id: firstCampaignId, sent_at: "2026-07-04T12:00:00.000Z" },
        { id: "70000000-0000-4000-8000-000000000002", user_id: userId, campaign_id: firstCampaignId, sent_at: "2026-07-05T12:00:00.000Z" },
        { id: "70000000-0000-4000-8000-000000000003", user_id: userId, campaign_id: secondCampaignId, sent_at: "2026-07-06T12:00:00.000Z" }
      ],
      appointments: [
        { id: "80000000-0000-4000-8000-000000000001", user_id: userId, campaign_id: firstCampaignId, campaign_attributed_at: "2026-07-07T12:00:00.000Z", status: "scheduled", price: 100 },
        { id: "80000000-0000-4000-8000-000000000002", user_id: userId, campaign_id: secondCampaignId, campaign_attributed_at: "2026-07-08T12:00:00.000Z", status: "completed", price: 200 },
        { id: "80000000-0000-4000-8000-000000000003", user_id: userId, campaign_id: secondCampaignId, campaign_attributed_at: "2026-07-09T12:00:00.000Z", status: "scheduled", price: 50 },
        { id: "80000000-0000-4000-8000-000000000004", user_id: userId, campaign_id: secondCampaignId, campaign_attributed_at: "2026-07-10T12:00:00.000Z", status: "cancelled", price: 500 }
      ]
    });
    try {
      const response = await getInsights();
      assert.equal(response.campaigns.available, true);
      if (!response.campaigns.available) throw new Error("Expected available campaigns");
      assert.equal(response.campaigns.period.label, "This Month");
      assert.equal(response.campaigns.campaign_count, 2);
      assert.equal(response.campaigns.active_campaign_count, 1);
      assert.deepEqual(response.campaigns.active_statuses, ["scheduled", "sending"]);
      assert.deepEqual(response.campaigns.totals, {
        emails_sent: 3,
        appointments_booked: 3,
        attributed_revenue: { kind: "money", amount_minor: 35000, currency: "USD" }
      });
      assert.deepEqual(response.campaigns.top_campaign, {
        campaign_id: secondCampaignId,
        name: "Summer Refresh",
        status: "completed",
        appointments_booked: 2,
        attributed_revenue: { kind: "money", amount_minor: 25000, currency: "USD" }
      });
    } finally {
      supabase.restore();
    }
  });
});
