import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envBooleanSchema = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "true");

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.string().min(1).optional(),
  AUTH_MODE: z.enum(["dev", "production"]).default("production"),
  ENABLE_DEV_AUTH_FALLBACK: envBooleanSchema,
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  DEV_AUTH_USER_ID: z.string().uuid().optional(),
  DEV_AUTH_USER_EMAIL: z.string().email().optional(),
  CLIENT_APP_URL: z.string().url().optional(),
  WEB_APP_URL: z.string().url().optional(),
  INTERNAL_API_SECRET: z.string().min(16).optional(),
  ADMIN_API_KEY: z.string().min(16).optional(),
  API_REQUEST_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  EMAIL_REPLY_TO: z.string().email().optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional()
});

export type AppEnvironment = "development" | "test" | "staging" | "production";

const normalizeAppEnvironment = (value: string | undefined): AppEnvironment => {
  switch (value) {
    case "production":
    case "staging":
    case "test":
      return value;
    default:
      return "development";
  }
};

export const parseEnv = (rawEnv: NodeJS.ProcessEnv) => {
  const parsedEnv = envSchema.safeParse(rawEnv);

  if (!parsedEnv.success) {
    const issues = parsedEnv.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");

    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  if (parsedEnv.data.NODE_ENV === "production" && parsedEnv.data.AUTH_MODE === "dev") {
    throw new Error(
      "Invalid environment configuration: AUTH_MODE must be production when NODE_ENV is production"
    );
  }

  return parsedEnv.data;
};

export const env = parseEnv(process.env);

export const getAppEnvironment = (rawEnv: NodeJS.ProcessEnv = process.env): AppEnvironment =>
  normalizeAppEnvironment(rawEnv.APP_ENV ?? rawEnv.NODE_ENV);
