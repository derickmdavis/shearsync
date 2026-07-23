import { ApiError } from "./errors";

export const APP_CONTENT_DEFAULT_LOCALE = "en-US" as const;
export const APP_CONTENT_CATEGORIES = [
  "screen",
  "section",
  "empty_state",
  "cta",
  "upgrade",
  "callout",
  "dialog",
  "onboarding"
] as const;

export type AppContentCategory = (typeof APP_CONTENT_CATEGORIES)[number];

export interface AppContentDefinitionContract {
  key: string;
  namespace: string;
  category: AppContentCategory;
  description: string;
  allowedPlaceholders: string[];
  maxLength: number;
  multilineAllowed: boolean;
  isActive: boolean;
  fallbackRequired: boolean;
  developerNotes: string | null;
}

export interface AppContentValidationIssue {
  code: "blank" | "length" | "newline" | "control_character" | "markup" | "placeholder";
  message: string;
  placeholder?: string;
}

export const APP_CONTENT_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
export const APP_CONTENT_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const APP_CONTENT_PLACEHOLDER_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export const normalizeAppContentLocale = (value: string): string => {
  const match = /^([a-z]{2,3})(?:-([a-z]{2}))?$/i.exec(value.trim());
  if (!match) throw new ApiError(400, "Invalid app-content locale");
  return match[2] ? `${match[1]!.toLowerCase()}-${match[2]!.toUpperCase()}` : match[1]!.toLowerCase();
};

export const normalizeSupportedAppContentLocale = (value: string): typeof APP_CONTENT_DEFAULT_LOCALE => {
  const locale = normalizeAppContentLocale(value);
  if (locale === APP_CONTENT_DEFAULT_LOCALE) return APP_CONTENT_DEFAULT_LOCALE;
  throw new ApiError(400, "Unsupported app-content locale", { supported_locales: [APP_CONTENT_DEFAULT_LOCALE] });
};

export const normalizeAppContentValue = (value: string): string =>
  value.replace(/\r\n?/g, "\n").trim();

const extractPlaceholders = (value: string): string[] => {
  const placeholders: string[] = [];
  const matcher = /\{\{([a-z][a-zA-Z0-9]*)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(value)) !== null) {
    placeholders.push(match[1]!);
  }

  return placeholders;
};

export const validateAppContentValue = (
  rawValue: string,
  definition: Pick<AppContentDefinitionContract, "allowedPlaceholders" | "maxLength" | "multilineAllowed">
): { value: string; placeholders: string[]; issues: AppContentValidationIssue[] } => {
  const value = normalizeAppContentValue(rawValue);
  const issues: AppContentValidationIssue[] = [];

  if (!value) {
    issues.push({ code: "blank", message: "Content value cannot be blank" });
  }

  if (value.length > definition.maxLength) {
    issues.push({
      code: "length",
      message: `Content value must be ${definition.maxLength} characters or fewer`
    });
  }

  if (!definition.multilineAllowed && value.includes("\n")) {
    issues.push({ code: "newline", message: "This content key does not allow line breaks" });
  }

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    issues.push({ code: "control_character", message: "Content contains unsupported control characters" });
  }

  if (/[<>]/.test(value)) {
    issues.push({ code: "markup", message: "Content must be plain text and cannot contain markup" });
  }

  const placeholders = extractPlaceholders(value);
  const remainingBraces = value.replace(/\{\{[a-z][a-zA-Z0-9]*\}\}/g, "");
  if (remainingBraces.includes("{") || remainingBraces.includes("}")) {
    issues.push({ code: "placeholder", message: "Content contains malformed placeholder syntax" });
  }

  const allowed = new Set(definition.allowedPlaceholders);
  for (const placeholder of placeholders) {
    if (!allowed.has(placeholder)) {
      issues.push({
        code: "placeholder",
        placeholder,
        message: `Placeholder {{${placeholder}}} is not allowed for this content key`
      });
    }
  }

  return { value, placeholders, issues };
};
