export type SafeMetadataPrimitive = string | number | boolean | null;
export type SafeMetadataValue = SafeMetadataPrimitive | SafeMetadataValue[] | { [key: string]: SafeMetadataValue };
export type SafeMetadata = { [key: string]: SafeMetadataValue };

const REDACTED = "[redacted]";
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;
const MAX_SERIALIZED_BYTES = 16_000;

const SENSITIVE_KEY_PATTERN =
  /(^|_)(email|phone|message|body|token|authorization|ip)$|signed_?url$|payment_?url$|qr_image_(path|url)$/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_URL_PATTERN =
  /\bhttps?:\/\/[^\s"'<>]*(?:token|signature|signed|venmo|paypal|cash\.app|zelle|stripe|square|payment)[^\s"'<>]*/gi;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSensitiveKey = (key: string): boolean =>
  !/^has_/i.test(key) && SENSITIVE_KEY_PATTERN.test(key);

const truncateString = (value: string): string =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;

const sanitizeString = (value: string): string => {
  if (UUID_PATTERN.test(value)) {
    return value;
  }

  const sanitized = value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(IP_PATTERN, REDACTED)
    .replace(PHONE_PATTERN, REDACTED)
    .replace(BEARER_TOKEN_PATTERN, REDACTED)
    .replace(SENSITIVE_URL_PATTERN, REDACTED);

  return truncateString(sanitized);
};

const sanitizeValue = (value: unknown, depth: number, seen: WeakSet<object>): SafeMetadataValue | undefined => {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return "[max-depth]";
    }

    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen))
      .filter((item): item is SafeMetadataValue => item !== undefined);
  }

  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) {
      return "[max-depth]";
    }

    if (seen.has(value)) {
      return "[circular]";
    }

    seen.add(value);

    const sanitized: SafeMetadata = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED;
        continue;
      }

      const sanitizedItem = sanitizeValue(item, depth + 1, seen);
      if (sanitizedItem !== undefined) {
        sanitized[key] = sanitizedItem;
      }
    }

    seen.delete(value);
    return sanitized;
  }

  return undefined;
};

const trimToSerializedLimit = (metadata: SafeMetadata): SafeMetadata => {
  const serialized = JSON.stringify(metadata);
  if (serialized.length <= MAX_SERIALIZED_BYTES) {
    return metadata;
  }

  return {
    ...metadata,
    _truncated: true,
    _summary: truncateString(serialized.slice(0, MAX_STRING_LENGTH))
  };
};

export const sanitizeMetadata = (input: unknown): SafeMetadata => {
  const seen = new WeakSet<object>();
  const sanitized = sanitizeValue(input, 0, seen);

  if (!isPlainObject(sanitized)) {
    return {};
  }

  return trimToSerializedLimit(sanitized);
};
