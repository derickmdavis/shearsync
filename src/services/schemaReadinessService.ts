import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { getMissingColumnName } from "./db";

const REQUIRED_SCHEMA_VERSION = "client_avatar_image_contract_2026_06_30";

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
    "purge_after"
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
