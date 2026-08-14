import { validateRequest } from "twilio";
import { env } from "../config/env";

export interface TwilioWebhookValidationInput {
  authToken?: string;
  publicApiBaseUrl?: string;
  signature?: string;
  originalUrl: string;
  body: unknown;
}

const toFormParameters = (body: unknown): Record<string, string | string[]> | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const parameters: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") parameters[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) parameters[key] = value;
    else return null;
  }
  return parameters;
};

/** Builds the public URL Twilio signed, independent of reverse-proxy request metadata. */
export const getTwilioWebhookUrl = (publicApiBaseUrl: string | undefined, originalUrl: string): string | null => {
  if (!publicApiBaseUrl || !originalUrl.startsWith("/")) return null;
  return `${publicApiBaseUrl.replace(/\/$/, "")}${originalUrl}`;
};

/** Validates a form-encoded Twilio callback. It deliberately has no route, database, or consent behavior. */
export const isValidTwilioWebhook = (input: TwilioWebhookValidationInput): boolean => {
  const authToken = input.authToken?.trim();
  const signature = input.signature?.trim();
  const url = getTwilioWebhookUrl(input.publicApiBaseUrl, input.originalUrl);
  const parameters = toFormParameters(input.body);
  if (!authToken || !signature || !url || !parameters) return false;
  return validateRequest(authToken, signature, url, parameters);
};

/** Production configuration wrapper for route middleware added in the next step. */
export const isValidConfiguredTwilioWebhook = (input: Omit<TwilioWebhookValidationInput, "authToken" | "publicApiBaseUrl">): boolean =>
  isValidTwilioWebhook({
    ...input,
    authToken: env.TWILIO_AUTH_TOKEN,
    publicApiBaseUrl: env.PUBLIC_API_BASE_URL
  });
