import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { getMissingColumnName } from "./db";

const REQUIRED_SCHEMA_VERSION = "202606030001_align_user_owned_events_and_profile_schema";

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
    "total_spend",
    "last_visit_at",
    "deleted_at",
    "deleted_reason"
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
  }
};
