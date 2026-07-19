import { getAppEnvironment } from "../config/env";
import { sanitizeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row } from "./db";

export const JOB_NAMES = [
  "appointment-emails-worker",
  "appointment-reminders-worker",
  "birthday-reminder-worker",
  "rebook-nudge-worker",
  "thank-you-email-worker",
  "api-request-logs-cleanup",
  "client-purge-worker",
  "appointment-image-cleanup-worker",
  "campaign-delivery-worker"
] as const;

export type JobName = typeof JOB_NAMES[number];
export type JobRunStatus = "started" | "completed" | "failed" | "skipped" | "cancelled";

export interface JobRunStats {
  recordsProcessed?: number;
  recordsSucceeded?: number;
  recordsFailed?: number;
}

export interface JobRunRange {
  start: Date | string;
  end?: Date | string;
}

const JOB_NAME_SET = new Set<string>(JOB_NAMES);
const ERROR_MESSAGE_MAX_LENGTH = 500;

const toIso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;

const normalizeJobName = (jobName: string): JobName => {
  const normalized = jobName.trim();
  if (!JOB_NAME_SET.has(normalized)) {
    throw new Error(`Unknown job name: ${jobName}`);
  }

  return normalized as JobName;
};

const normalizeNumber = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
};

const getErrorCode = (error: unknown): string | null => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 100);
  }

  return null;
};

const getErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_MESSAGE_MAX_LENGTH ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH) : message;
};

const getDurationMs = (startedAt: string, finishedAt: Date): number =>
  Math.max(0, finishedAt.getTime() - new Date(startedAt).getTime());

const updateJobRun = async (
  jobRunId: string,
  payload: Row
): Promise<Row> => {
  const { data, error } = await supabaseAdmin
    .from("job_runs")
    .update(payload)
    .eq("id", jobRunId)
    .select("*")
    .single();

  handleSupabaseError(error, "Unable to update job run");
  return data as Row;
};

const loadJobRun = async (jobRunId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("job_runs")
    .select("*")
    .eq("id", jobRunId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load job run");
  return data as Row | null;
};

export const jobRunsService = {
  async startJobRun(jobName: string, metadata: unknown = {}): Promise<Row> {
    const startedAt = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("job_runs")
      .insert({
        environment: getAppEnvironment(),
        job_name: normalizeJobName(jobName),
        status: "started",
        started_at: startedAt,
        finished_at: null,
        duration_ms: null,
        records_processed: 0,
        records_succeeded: 0,
        records_failed: 0,
        error_code: null,
        error_message: null,
        metadata: sanitizeMetadata(metadata)
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to start job run");
    return data as Row;
  },

  async completeJobRun(jobRunId: string, stats: JobRunStats = {}): Promise<Row> {
    const existing = await loadJobRun(jobRunId);
    const finishedAt = new Date();

    return updateJobRun(jobRunId, {
      status: "completed",
      finished_at: finishedAt.toISOString(),
      duration_ms: existing?.started_at ? getDurationMs(String(existing.started_at), finishedAt) : null,
      records_processed: normalizeNumber(stats.recordsProcessed),
      records_succeeded: normalizeNumber(stats.recordsSucceeded),
      records_failed: normalizeNumber(stats.recordsFailed),
      error_code: null,
      error_message: null
    });
  },

  async failJobRun(jobRunId: string, error: unknown, stats: JobRunStats = {}): Promise<Row> {
    const existing = await loadJobRun(jobRunId);
    const finishedAt = new Date();

    return updateJobRun(jobRunId, {
      status: "failed",
      finished_at: finishedAt.toISOString(),
      duration_ms: existing?.started_at ? getDurationMs(String(existing.started_at), finishedAt) : null,
      records_processed: normalizeNumber(stats.recordsProcessed),
      records_succeeded: normalizeNumber(stats.recordsSucceeded),
      records_failed: normalizeNumber(stats.recordsFailed),
      error_code: getErrorCode(error),
      error_message: getErrorMessage(error)
    });
  },

  async skipJobRun(jobName: string, reason: string, metadata: unknown = {}): Promise<Row> {
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("job_runs")
      .insert({
        environment: getAppEnvironment(),
        job_name: normalizeJobName(jobName),
        status: "skipped",
        started_at: now,
        finished_at: now,
        duration_ms: 0,
        records_processed: 0,
        records_succeeded: 0,
        records_failed: 0,
        error_code: "skipped",
        error_message: reason.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        metadata: sanitizeMetadata(metadata)
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to skip job run");
    return data as Row;
  },

  async getLastSuccessfulJobRun(): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("job_runs")
      .select("*")
      .eq("environment", getAppEnvironment())
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load last successful job run");
    return data as Row | null;
  },

  async getFailedJobsCount(range: JobRunRange): Promise<number> {
    let query = supabaseAdmin
      .from("job_runs")
      .select("id", { count: "exact", head: true })
      .eq("environment", getAppEnvironment())
      .eq("status", "failed")
      .gte("created_at", toIso(range.start));

    if (range.end) {
      query = query.lte("created_at", toIso(range.end));
    }

    const { count, error } = await query;
    handleSupabaseError(error, "Unable to load failed jobs count");
    return count ?? 0;
  }
};
