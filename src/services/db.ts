import type { PostgrestError } from "@supabase/supabase-js";
import { ApiError } from "../lib/errors";

export type Row = Record<string, unknown>;
export type RowList = Row[];

export const handleSupabaseError = (error: PostgrestError | null, fallbackMessage: string): void => {
  if (!error) {
    return;
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

export const isMissingColumnError = (error: PostgrestError | null, column?: string): boolean => {
  const missingColumn = getMissingColumnName(error);

  if (!missingColumn) {
    return false;
  }

  return column ? missingColumn === column : true;
};

export const normalizeEmptyString = (value: string | undefined): string | undefined => {
  if (value === "") {
    return undefined;
  }

  return value?.trim();
};
