import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { getMissingColumnName } from "./db";

const REQUIRED_SCHEMA_VERSION = "campaign_delivery_analytics_2026_07_18";

const REQUIRED_TABLE_COLUMNS = {
  users: [
    "id",
    "email",
    "location_label",
    "avatar_image_id",
    "timezone",
    "plan_tier",
    "plan_status",
    "sms_monthly_limit",
    "sms_used_this_month",
    "waitlist_enabled",
    "plan_started_at",
    "plan_updated_at"
  ],
  clients: [
    "id",
    "user_id",
    "first_name",
    "last_name",
    "preferred_name",
    "phone",
    "phone_normalized",
    "email",
    "instagram",
    "birthday",
    "notes",
    "preferred_contact_method",
    "tags",
    "source",
    "reminder_consent",
    "is_vip",
    "avatar_image_id",
    "total_spend",
    "last_visit_at",
    "deleted_at",
    "deleted_reason",
    "purge_after",
    "original_referral_link_id",
    "original_referred_by_client_id",
    "original_referral_code",
    "original_acquisition_source",
    "original_referral_attributed_at"
  ],
  client_referral_links: [
    "id",
    "user_id",
    "client_id",
    "referral_code",
    "referral_url",
    "status",
    "source",
    "disabled_at",
    "created_at",
    "updated_at"
  ],
  appointments: [
    "id",
    "user_id",
    "client_id",
    "appointment_date",
    "service_name",
    "duration_minutes",
    "price",
    "notes",
    "status",
    "booking_source",
    "appointment_time_range",
    "service_id",
    "referral_link_id",
    "referred_by_client_id",
    "referral_code_used",
    "referral_attributed_at",
    "acquisition_source",
    "campaign_id",
    "campaign_run_id",
    "campaign_recipient_id",
    "campaign_attributed_at",
    "created_at",
    "updated_at"
  ],
  referral_events: [
    "id",
    "referral_link_id",
    "user_id",
    "referred_by_client_id",
    "referred_client_id",
    "appointment_id",
    "event_type",
    "source",
    "campaign_id",
    "email_delivery_id",
    "metadata",
    "ip_hash",
    "user_agent",
    "created_at"
  ],
  thank_you_emails: [
    "id",
    "user_id",
    "client_id",
    "appointment_id",
    "referral_link_id",
    "email_event_id",
    "recipient_email",
    "status",
    "approval_required",
    "send_after",
    "referral_code_snapshot",
    "referral_url_snapshot",
    "qr_code_url_snapshot",
    "subject_snapshot",
    "custom_message_block_snapshot",
    "template_data",
    "approved_at",
    "cancelled_at",
    "cancelled_reason",
    "sent_at",
    "error",
    "created_at",
    "updated_at"
  ],
  thank_you_email_settings: [
    "user_id",
    "approval_required",
    "send_delay_hours",
    "subject_template",
    "custom_message_block",
    "created_at",
    "updated_at"
  ],
  appointment_email_events: [
    "id",
    "user_id",
    "client_id",
    "appointment_id",
    "rebook_nudge_id",
    "birthday_reminder_id",
    "thank_you_email_id",
    "email_type",
    "recipient_email",
    "status",
    "idempotency_key",
    "provider",
    "provider_message_id",
    "template_data",
    "error",
    "attempt_count",
    "last_attempt_at",
    "sent_at",
    "created_at",
    "updated_at"
  ],
  payment_methods: [
    "id",
    "user_id",
    "provider",
    "display_name",
    "payment_url",
    "qr_image_url",
    "qr_image_path",
    "instructions",
    "is_default",
    "is_active",
    "sort_order",
    "created_at",
    "updated_at"
  ],
  admin_users: [
    "id",
    "email",
    "is_active",
    "created_at"
  ],
  admin_account_notes: [
    "id",
    "account_user_id",
    "created_by_admin_email",
    "note",
    "metadata",
    "created_at"
  ],
  product_events: [
    "id",
    "environment",
    "account_user_id",
    "actor_user_id",
    "client_id",
    "appointment_id",
    "event_type",
    "event_source",
    "stylist_slug",
    "anonymous_id",
    "session_id",
    "dedupe_key",
    "metadata",
    "created_at"
  ],
  notification_events: [
    "id",
    "environment",
    "account_user_id",
    "actor_user_id",
    "client_id",
    "appointment_id",
    "notification_type",
    "channel",
    "status",
    "provider",
    "provider_message_id",
    "provider_error_code",
    "provider_error_message",
    "metadata",
    "created_at"
  ],
  job_runs: [
    "id",
    "environment",
    "job_name",
    "status",
    "started_at",
    "finished_at",
    "duration_ms",
    "records_processed",
    "records_succeeded",
    "records_failed",
    "error_code",
    "error_message",
    "metadata",
    "created_at",
    "updated_at"
  ],
  api_request_logs: [
    "id",
    "environment",
    "request_id",
    "method",
    "path",
    "route_pattern",
    "status_code",
    "duration_ms",
    "account_user_id",
    "actor_user_id",
    "error_code",
    "error_message",
    "severity",
    "metadata",
    "created_at"
  ],
  booking_error_events: [
    "id",
    "environment",
    "account_user_id",
    "client_id",
    "appointment_id",
    "stylist_slug",
    "request_id",
    "session_id",
    "anonymous_id",
    "step",
    "error_code",
    "severity",
    "error_message",
    "metadata",
    "created_at"
  ],
  client_rebooking_preferences: [
    "id",
    "user_id",
    "client_id",
    "preferred_interval_days",
    "source",
    "created_at",
    "updated_at"
  ],
  campaign_templates: [
    "id", "name", "description", "link_type", "subject", "message", "version",
    "active", "sort_order", "icon_key", "created_at", "updated_at"
  ],
  campaigns: [
    "id", "user_id", "name", "status", "campaign_kind", "send_mode", "scheduled_for",
    "timezone_snapshot", "link_type", "template_id", "template_version", "subject_snapshot",
    "message_snapshot", "audience_mode", "revision", "validated_at", "validation_nonce_hash",
    "scheduled_at", "sending_started_at", "completed_at", "cancelled_at", "cancelled_reason",
    "failure_summary", "created_at", "updated_at"
  ],
  campaign_runs: [
    "id", "campaign_id", "user_id", "sequence_number", "status", "scheduled_for", "started_at",
    "completed_at", "cancelled_at", "recipient_total", "eligible_count", "excluded_count",
    "pending_count", "sending_count", "sent_count", "failed_count", "created_at", "updated_at"
  ],
  campaign_audience_selections: ["campaign_id", "user_id", "client_id", "created_at"],
  campaign_recipients: [
    "id", "campaign_id", "campaign_run_id", "user_id", "client_id", "recipient_email_snapshot",
    "first_name_snapshot", "eligibility_status", "exclusion_reason", "subject_snapshot",
    "rendered_text_snapshot", "rendered_html_snapshot", "render_version",
    "booking_tracking_token_hash", "referral_link_id", "status", "idempotency_key", "provider",
    "provider_message_id", "attempt_count", "last_attempt_at", "queued_at", "sending_started_at",
    "sent_at", "delivered_at", "failed_at", "skipped_at", "cancelled_at", "error_code",
    "error_message", "created_at", "updated_at"
  ],
  campaign_idempotency_records: [
    "id", "user_id", "scope", "idempotency_key", "request_hash", "response_status",
    "response_body", "resource_type", "resource_id", "locked_at", "completed_at", "expires_at",
    "created_at", "updated_at"
  ],
  campaign_delivery_events: [
    "id", "campaign_id", "campaign_recipient_id", "user_id", "provider", "provider_event_id",
    "provider_message_id", "event_type", "occurred_at", "url", "is_automated", "privacy_limited",
    "provider_payload", "created_at"
  ],
  outreach_schema_versions: [
    "component", "version", "applied_at"
  ]
} as const;

const toSchemaError = (table: string, error: PostgrestError): ApiError => {
  const missingColumn = getMissingColumnName(error);

  return new ApiError(
    503,
    "Database schema is out of date; apply the required Supabase migrations.",
    {
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      table,
      missingColumn,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    },
    { exposeDetails: true }
  );
};

export const schemaReadinessService = {
  requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,

  async assertReady(): Promise<void> {
    for (const [table, columns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      const { error } = await supabaseAdmin
        .from(table)
        .select(columns.join(", "))
        .limit(1);

      if (error) {
        throw toSchemaError(table, error);
      }
    }

    const { data: outreachSchemaVersion, error: outreachSchemaVersionError } = await supabaseAdmin
      .from("outreach_schema_versions")
      .select("version")
      .eq("component", "campaign_authoring")
      .maybeSingle();

    if (outreachSchemaVersionError) {
      throw toSchemaError("outreach_schema_versions", outreachSchemaVersionError);
    }

    if (outreachSchemaVersion?.version !== REQUIRED_SCHEMA_VERSION) {
      throw new ApiError(
        503,
        "Database schema is out of date; apply the required Supabase migrations.",
        {
          requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
          table: "outreach_schema_versions",
          component: "campaign_authoring",
          actualSchemaVersion: outreachSchemaVersion?.version ?? null
        },
        { exposeDetails: true }
      );
    }

    const { error: paymentQrBucketError } = await supabaseAdmin.storage.getBucket("payment-method-qrs");

    if (paymentQrBucketError) {
      throw new ApiError(
        503,
        "Database schema is out of date; apply the required Supabase migrations.",
        {
          requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
          bucket: "payment-method-qrs",
          message: paymentQrBucketError.message
        },
        { exposeDetails: true }
      );
    }
  }
};
