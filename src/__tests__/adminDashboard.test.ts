import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { adminDashboardService } =
  require("../services/adminDashboardService") as typeof import("../services/adminDashboardService");

const USER_ID = "11111111-1111-4111-8111-111111111111";

const baseAdminState = () => ({
  users: [
    {
      id: USER_ID,
      email: "stylist@example.com",
      business_name: "Maya Studio",
      full_name: "Maya Artist",
      timezone: "America/Denver",
      plan_tier: "pro",
      plan_status: "active",
      created_at: "2026-06-01T00:00:00.000Z"
    }
  ],
  stylists: [
    {
      user_id: USER_ID,
      slug: "maya-studio",
      display_name: "Maya",
      booking_enabled: true,
      created_at: "2026-06-01T00:00:00.000Z"
    }
  ],
  services: [
    { id: "service-1", user_id: USER_ID, is_active: true, visible: true, created_at: "2026-06-01T00:00:00.000Z" }
  ],
  availability: [
    { id: "availability-1", user_id: USER_ID, is_active: true, created_at: "2026-06-01T00:00:00.000Z" }
  ],
  clients: [
    { id: "client-1", user_id: USER_ID, created_at: "2026-06-20T00:00:00.000Z" }
  ],
  appointments: [
    {
      id: "appointment-1",
      user_id: USER_ID,
      client_id: "client-1",
      status: "completed",
      booking_source: "public",
      price: 120,
      appointment_date: "2026-06-23T18:00:00.000Z",
      created_at: "2026-06-22T18:00:00.000Z"
    }
  ],
  payment_methods: [
    { id: "payment-1", user_id: USER_ID, is_active: true, created_at: "2026-06-01T00:00:00.000Z" }
  ],
  automation_settings: [
    { id: "automation-1", user_id: USER_ID, key: "appointment_reminders", enabled: true, created_at: "2026-06-01T00:00:00.000Z" }
  ],
  product_events: [
    {
      id: "event-1",
      environment: "test",
      account_user_id: USER_ID,
      event_type: "appointment_created",
      created_at: "2026-06-23T12:00:00.000Z"
    },
    {
      id: "event-2",
      environment: "test",
      account_user_id: USER_ID,
      event_type: "booking_page_viewed",
      created_at: "2026-06-23T12:05:00.000Z"
    },
    {
      id: "event-3",
      environment: "test",
      account_user_id: USER_ID,
      event_type: "payment_qr_shown",
      created_at: "2026-06-23T12:10:00.000Z"
    },
    {
      id: "event-4",
      environment: "test",
      account_user_id: USER_ID,
      event_type: "user_opened_app",
      created_at: "2026-06-23T16:00:00.000Z"
    }
  ],
  notification_events: [
    {
      id: "notification-1",
      environment: "test",
      account_user_id: USER_ID,
      channel: "email",
      notification_type: "appointment_reminder",
      status: "sent",
      created_at: "2026-06-23T13:00:00.000Z"
    }
  ],
  booking_error_events: [],
  api_request_logs: [
    {
      id: "request-log-1",
      environment: "test",
      duration_ms: 50,
      status_code: 200,
      severity: "info",
      created_at: "2026-06-23T13:00:00.000Z"
    }
  ],
  job_runs: [
    {
      id: "job-1",
      environment: "test",
      job_name: "appointment-emails-worker",
      status: "completed",
      finished_at: "2026-06-23T13:00:00.000Z",
      created_at: "2026-06-23T13:00:00.000Z"
    }
  ],
  admin_account_notes: [
    {
      id: "note-1",
      account_user_id: USER_ID,
      created_by_admin_email: "admin@example.com",
      note: "Setup reviewed.",
      metadata: {},
      created_at: "2026-06-23T14:00:00.000Z"
    }
  ]
});

describe("admin dashboard service", () => {
  it("returns system health from telemetry tables", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-24T12:00:00.000Z") });
    const db = installMockSupabase(baseAdminState());

    try {
      const health = await adminDashboardService.getSystemHealth();

      assert.equal(health.environment, "test");
      assert.equal(health.db.status, "ok");
      assert.equal(health.emailQueue.sentLast24h, 1);
      assert.equal(health.jobs.failedLast24h, 0);
      assert.equal(health.api.latency.averageMs, 50);
    } finally {
      mock.timers.reset();
      db.restore();
    }
  });

  it("returns business overview with appointment price fallback revenue", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-24T12:00:00.000Z") });
    const db = installMockSupabase(baseAdminState());

    try {
      const overview = await adminDashboardService.getBusinessOverview("30d");

      assert.equal(overview.totalStylists, 1);
      assert.equal(overview.appointments.publicBookingsSubmitted, 1);
      assert.deepEqual(overview.revenue, {
        recorded: 120,
        source: "appointment_price_fallback"
      });
      assert.equal("appointment_payments" in overview, false);
    } finally {
      mock.timers.reset();
      db.restore();
    }
  });

  it("returns account rows and account detail with payment shortcut usage", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-24T12:00:00.000Z") });
    const db = installMockSupabase(baseAdminState());

    try {
      const accounts = await adminDashboardService.getAccounts("30d");
      const detail = await adminDashboardService.getAccountDetail(USER_ID, "30d");

      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.setupScore, 100);
      assert.equal(accounts[0]?.health.status, "healthy");
      assert.equal(accounts[0]?.lastLogin, "2026-06-23T16:00:00.000Z");
      assert.equal(detail.summary.lastLogin, "2026-06-23T16:00:00.000Z");
      assert.deepEqual(detail.paymentShortcutUsage, {
        methodsConfigured: 1,
        qrShownLast30Days: 1,
        linkOpenedLast30Days: 0
      });
      assert.equal(detail.supportNotes.length, 1);
    } finally {
      mock.timers.reset();
      db.restore();
    }
  });

  it("marks accounts at risk when setup and recent activity are weak", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-24T12:00:00.000Z") });
    const state = baseAdminState() as Record<string, Record<string, unknown>[]>;
    state.users[0] = {
      ...state.users[0],
      business_name: null as unknown as string,
      timezone: null as unknown as string
    };
    state.stylists[0] = {
      ...state.stylists[0],
      display_name: null as unknown as string,
      booking_enabled: false
    };
    state.services = [];
    state.availability = [];
    state.clients = [];
    state.appointments = [];
    state.payment_methods = [];
    state.automation_settings = [];
    state.product_events = [];
    state.booking_error_events = [
      {
        id: "booking-error-1",
        environment: "test",
        account_user_id: USER_ID,
        severity: "warning",
        created_at: "2026-06-23T12:00:00.000Z"
      },
      {
        id: "booking-error-2",
        environment: "test",
        account_user_id: USER_ID,
        severity: "warning",
        created_at: "2026-06-23T12:05:00.000Z"
      },
      {
        id: "booking-error-3",
        environment: "test",
        account_user_id: USER_ID,
        severity: "warning",
        created_at: "2026-06-23T12:10:00.000Z"
      }
    ];
    const db = installMockSupabase(state);

    try {
      const [account] = await adminDashboardService.getAccounts("30d");

      assert.equal(account?.setupScore, 0);
      assert.equal(account?.health.status, "at_risk");
      assert.deepEqual(account?.health.reasons, [
        "setup_score_below_70",
        "no_appointments_last_30_days",
        "booking_page_disabled"
      ]);
    } finally {
      mock.timers.reset();
      db.restore();
    }
  });
});
