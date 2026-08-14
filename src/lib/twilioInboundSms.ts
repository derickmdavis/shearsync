import { ApiError } from "./errors";
import { normalizePhone } from "./communications";

export type InboundSmsClassification = "stop" | "start" | "help" | "other";
export type InboundSmsClassificationSource = "twilio_opt_out_type" | "keyword_fallback";

export interface TwilioInboundSms {
  from: string;
  fromNormalized: string;
  to: string | null;
  toNormalized: string | null;
  body: string;
  messageSid: string;
  classification: InboundSmsClassification;
  classificationSource: InboundSmsClassificationSource;
  providerMetadata: Record<string, string | null>;
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

const getText = (body: unknown, key: string): string | null => {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const classifyKeyword = (body: string): InboundSmsClassification => {
  const keyword = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(keyword)) return "stop";
  if (START_KEYWORDS.has(keyword)) return "start";
  if (HELP_KEYWORDS.has(keyword)) return "help";
  return "other";
};

const classifyOptOutType = (value: string | null): InboundSmsClassification | null => {
  if (!value) return null;
  switch (value.toUpperCase()) {
    case "STOP": return "stop";
    case "START": return "start";
    case "HELP": return "help";
    default: return null;
  }
};

/** Parses Twilio's form callback into a validated, provider-specific payload. */
export const parseTwilioInboundSms = (body: unknown): TwilioInboundSms => {
  const from = getText(body, "From");
  const to = getText(body, "To");
  const messageSid = getText(body, "MessageSid");
  const messageBody = getText(body, "Body") ?? "";
  const fromNormalized = normalizePhone(from);
  const toNormalized = to ? normalizePhone(to) : null;
  if (!from || !fromNormalized || !messageSid || (to !== null && !toNormalized)) {
    throw new ApiError(400, "Twilio inbound SMS requires valid From, To, and MessageSid values");
  }
  const optOutType = getText(body, "OptOutType");
  const providerClassification = classifyOptOutType(optOutType);
  return {
    from,
    fromNormalized,
    to,
    toNormalized,
    body: messageBody,
    messageSid,
    classification: providerClassification ?? classifyKeyword(messageBody),
    classificationSource: providerClassification ? "twilio_opt_out_type" : "keyword_fallback",
    providerMetadata: { opt_out_type: optOutType, account_sid: getText(body, "AccountSid") }
  };
};
