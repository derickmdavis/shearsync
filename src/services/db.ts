import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "../lib/errors";

export type Row = Record<string, unknown>;
export type RowList = Row[];

// This version is intentionally kept with the database-error boundary: a
// partially applied Outreach release otherwise surfaces as an opaque 500 from
// any of its read models (including the Automations bootstrap).
const REQUIRED_OUTREACH_SCHEMA_VERSION = "campaign_delivery_analytics_2026_07_18";

const isSchemaMismatchError = (error: PostgrestError): boolean => {
  if (["42P01", "42703", "PGRST204", "PGRST205"].includes(error.code)) {
    return true;
  }

  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return /(?:relation|table|column) .+ does not exist|could not find (?:the )?(?:table|column)/i.test(text);
};

export const handleSupabaseError = (error: PostgrestError | null, fallbackMessage: string): void => {
  if (!error) {
    return;
  }

  if (isSchemaMismatchError(error)) {
    throw new ApiError(
      503,
      "Database schema is out of date; apply the required Supabase migrations.",
      {
        requiredSchemaVersion: REQUIRED_OUTREACH_SCHEMA_VERSION,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      },
      { exposeDetails: true }
    );
  }

  throw new ApiError(500, fallbackMessage, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint
  });
};

const MISSING_COLUMN_PATTERNS = [
  /Could not find the ['"]([A-Za-z0-9_]+)['"] column of ['"][A-Za-z0-9_]+['"] in the schema cache/i,
  /column [A-Za-z0-9_]+\.([A-Za-z0-9_]+) does not exist/i,
  /column ["']([A-Za-z0-9_]+)["'] of relation ["'][A-Za-z0-9_]+["'] does not exist/i,
  /column ["']([A-Za-z0-9_]+)["'] does not exist/i
];

export const getMissingColumnName = (error: PostgrestError | null): string | null => {
  if (!error) {
    return null;
  }

  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");

  for (const pattern of MISSING_COLUMN_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

export const normalizeEmptyString = (value: string | undefined): string | undefined => {
  if (value === "") {
    return undefined;
  }

  return value?.trim();
};
