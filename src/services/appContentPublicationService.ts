import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

const parseRpcDetails = (details: string | null | undefined): Record<string, unknown> | undefined => {
  if (!details) return undefined;
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const mapPublicationError = (error: { message?: string; details?: string | null; code?: string } | null): never => {
  const message = error?.message ?? "";
  const details = parseRpcDetails(error?.details);

  if (message.includes("app_content_locale_version_conflict")) {
    throw new ApiError(409, "App-content locale was published elsewhere", details, { exposeDetails: true });
  }
  if (message.includes("app_content_locale_not_found")) throw new ApiError(404, "App-content locale not found");
  if (message.includes("app_content_revision_not_found")) throw new ApiError(404, "App-content revision not found");
  if (message.includes("app_content_publish_no_active_definitions")) {
    throw new ApiError(422, "No active app-content definitions are available to publish");
  }
  if (message.includes("app_content_publish_missing_drafts")) {
    throw new ApiError(422, "Every active app-content definition needs a draft before publication", details, { exposeDetails: true });
  }
  if (message.includes("app_content_publish_invalid_drafts")) {
    throw new ApiError(422, "App-content drafts failed publication validation", details, { exposeDetails: true });
  }
  if (message.includes("app_content_rollback_missing_active_keys")) {
    throw new ApiError(422, "The selected revision does not contain every current active content key", details, { exposeDetails: true });
  }

  handleSupabaseError(error as never, "Unable to publish app-content");
  throw new ApiError(500, "Unable to publish app-content");
};

const revisionSelect = [
  "id", "locale", "version", "kind", "source_revision_id", "checksum",
  "published_by_admin_email", "published_by_user_id", "published_at", "created_at"
].join(", ");

const auditSelect = [
  "id", "event_type", "definition_key", "locale", "revision_id", "actor_user_id",
  "actor_admin_email", "previous_value", "new_value", "metadata", "created_at"
].join(", ");

export const appContentPublicationService = {
  async publish(input: { locale: string; expectedActiveVersion: number; actorUserId: string; actorEmail: string }) {
    const { data, error } = await supabaseAdmin.rpc("publish_app_content_locale", {
      p_locale: input.locale,
      p_expected_active_version: input.expectedActiveVersion,
      p_actor_user_id: input.actorUserId,
      p_actor_admin_email: input.actorEmail
    });
    if (error) {
      logger.warn("app_content_publication_failed", { locale: input.locale, actorUserId: input.actorUserId, code: error.code });
      mapPublicationError(error);
    }
    const result = data as unknown as Row;
    logger.info("app_content_published", {
      locale: input.locale,
      actorUserId: input.actorUserId,
      version: result.version,
      revisionId: result.revision_id
    });
    return result;
  },

  async rollback(input: {
    locale: string;
    revisionId: string;
    expectedActiveVersion: number;
    actorUserId: string;
    actorEmail: string;
  }) {
    const { data, error } = await supabaseAdmin.rpc("rollback_app_content_locale", {
      p_locale: input.locale,
      p_target_revision_id: input.revisionId,
      p_expected_active_version: input.expectedActiveVersion,
      p_actor_user_id: input.actorUserId,
      p_actor_admin_email: input.actorEmail
    });
    if (error) {
      logger.warn("app_content_rollback_failed", { locale: input.locale, actorUserId: input.actorUserId, code: error.code });
      mapPublicationError(error);
    }
    const result = data as unknown as Row;
    logger.info("app_content_rolled_back", {
      locale: input.locale,
      actorUserId: input.actorUserId,
      version: result.version,
      revisionId: result.revision_id,
      sourceRevisionId: result.source_revision_id
    });
    return result;
  },

  async listRevisions(input: { locale: string; limit: number; offset: number }) {
    const { data, error, count } = await supabaseAdmin
      .from("app_content_revisions")
      .select(revisionSelect, { count: "exact" })
      .eq("locale", input.locale)
      .order("version", { ascending: false })
      .range(input.offset, input.offset + input.limit - 1);
    handleSupabaseError(error, "Unable to load app-content revisions");
    return {
      data: (data ?? []) as unknown as RowList,
      page: { limit: input.limit, offset: input.offset, total: count ?? 0 }
    };
  },

  async getRevision(revisionId: string) {
    const { data: revisionData, error: revisionError } = await supabaseAdmin
      .from("app_content_revisions")
      .select(revisionSelect)
      .eq("id", revisionId)
      .maybeSingle();
    handleSupabaseError(revisionError, "Unable to load app-content revision");
    if (!revisionData) throw new ApiError(404, "App-content revision not found");

    const { data: entryData, error: entryError } = await supabaseAdmin
      .from("app_content_revision_entries")
      .select("revision_id, definition_key, value, created_at")
      .eq("revision_id", revisionId)
      .order("definition_key", { ascending: true });
    handleSupabaseError(entryError, "Unable to load app-content revision entries");
    return { ...revisionData as unknown as Row, entries: (entryData ?? []) as unknown as RowList };
  },

  async listAudit(input: { locale?: string; key?: string; revisionId?: string; limit: number; offset: number }) {
    let query = supabaseAdmin
      .from("app_content_audit_events")
      .select(auditSelect, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(input.offset, input.offset + input.limit - 1);
    if (input.locale) query = query.eq("locale", input.locale);
    if (input.key) query = query.eq("definition_key", input.key);
    if (input.revisionId) query = query.eq("revision_id", input.revisionId);

    const { data, error, count } = await query;
    handleSupabaseError(error, "Unable to load app-content audit events");
    return {
      data: (data ?? []) as unknown as RowList,
      page: { limit: input.limit, offset: input.offset, total: count ?? 0 }
    };
  }
};
