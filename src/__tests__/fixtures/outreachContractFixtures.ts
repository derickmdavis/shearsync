import type {
  CampaignDraftContract,
  OutreachAutomationsContract,
  ScheduledOutreachListContract
} from "../../lib/outreachContracts";

export const campaignDraftContractFixture: CampaignDraftContract = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "draft",
  campaign_kind: "one_time",
  revision: 1,
  name: "Summer Booking Boost",
  send_mode: "scheduled",
  send_at: "2026-07-20T15:00:00.000Z",
  timezone: "America/Denver",
  link_type: "booking_link",
  template_id: "22222222-2222-4222-8222-222222222222",
  template_version: 3,
  audience: {
    mode: "specific",
    client_ids: ["33333333-3333-4333-8333-333333333333"]
  },
  content: {
    subject: "A summer appointment for you",
    message: "Hi {{first_name}}, I would love to see you again this summer."
  },
  created_at: "2026-07-18T15:00:00.000Z",
  updated_at: "2026-07-18T15:05:00.000Z"
};

export const scheduledOutreachListContractFixture: ScheduledOutreachListContract = {
  data: [
    {
      id: "appointment_reminder:44444444-4444-4444-8444-444444444444:2026-07-19T16:00:00.000Z",
      kind: "appointment_reminder",
      status: "queued",
      channel: "email",
      send_at: "2026-07-18T16:00:00.000Z",
      recipient: {
        client_id: "33333333-3333-4333-8333-333333333333",
        display_name: "Sarah J."
      },
      appointment_id: "44444444-4444-4444-8444-444444444444",
      campaign_id: null,
      title: "Appointment reminder",
      context_label: "For appointment at 10:00 AM",
      can_cancel: true,
      cancel_scope: "single_send",
      allowed_actions: ["view_appointment", "view_client", "cancel"]
    },
    {
      id: "campaign:55555555-5555-4555-8555-555555555555",
      kind: "campaign",
      status: "queued",
      channel: "email",
      send_at: "2026-07-20T15:00:00.000Z",
      recipient: null,
      appointment_id: null,
      campaign_id: "55555555-5555-4555-8555-555555555555",
      title: "Summer Booking Boost",
      context_label: "118 eligible recipients",
      can_cancel: true,
      cancel_scope: "single_send",
      allowed_actions: ["view_campaign", "cancel"]
    }
  ],
  next_cursor: null,
  total_count: 2
};

export const outreachAutomationsContractFixture: OutreachAutomationsContract = {
  account_timezone: "America/Denver",
  summary: { enabled_count: 2, available_count: 2, total_count: 2 },
  controls: [
    {
      key: "rebook_nudges",
      label: "Rebook Nudges",
      enabled: true,
      feature_available: true,
      unavailable_reason: null,
      mode: "approval_required",
      pending_approval_count: 2,
      queued_count: 4,
      scheduled_count: 4,
      status_label: "2 need approval",
      settings_version: 7,
      channels: {
        email: { available: true, enabled: true, unavailable_reason: null },
        sms: { available: false, enabled: false, unavailable_reason: "Outbound SMS is not available yet." }
      },
      timing: { default_interval_days: 90 },
      settings: { approvalRequired: true, defaultRebookIntervalDays: 90 },
      content_rules: { subject_max_length: 160, message_max_length: 4000, available_tokens: ["client_name"] },
      templates: [],
      mutation: { method: "PATCH", path: "/api/settings/rebook-nudges" }
    },
    {
      key: "email_confirmations",
      label: "Email Confirmations",
      enabled: true,
      feature_available: true,
      unavailable_reason: null,
      mode: null,
      pending_approval_count: 0,
      queued_count: 0,
      scheduled_count: 0,
      status_label: "On for bookings",
      settings_version: null,
      channels: {
        email: { available: true, enabled: true, unavailable_reason: null },
        sms: { available: false, enabled: false, unavailable_reason: "Outbound SMS is not available yet." }
      },
      timing: {},
      settings: {},
      content_rules: null,
      templates: [],
      mutation: { method: "PATCH", path: "/api/activity/automation/settings/email_confirmations" }
    }
  ],
  customers_reached: {
    unique_clients: 38,
    window_start: "2026-06-18T00:00:00.000Z",
    window_end: "2026-07-18T00:00:00.000Z",
    timezone: "America/Denver",
    window_kind: "rolling",
    window_days: 30,
    included_message_types: ["appointment_reminder", "rebooking_prompt", "birthday_reminder", "marketing"]
  }
};
