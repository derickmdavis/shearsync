import { ApiError } from "../lib/errors";
import { APP_CONTENT_DEFAULT_LOCALE } from "../lib/appContent";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

export interface AppContentBundle {
  revisionId: string;
  version: number;
  locale: string;
  requestedLocale: string;
  fallbackApplied: boolean;
  publishedAt: string;
  checksum: string;
  content: Record<string, string>;
}

export const createAppContentEtag = (bundle: Pick<AppContentBundle, "locale" | "version" | "checksum">): string =>
  `"app-content-${bundle.locale}-v${bundle.version}-${bundle.checksum}"`;

export const ifNoneMatchMatches = (header: string | undefined, etag: string): boolean =>
  header?.split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag) ?? false;

export const appContentBundleService = {
  async getPublishedBundle(requestedLocale: string): Promise<AppContentBundle> {
    const loadState = async (locale: string) => {
      const { data, error } = await supabaseAdmin
        .from("app_content_locale_state")
        .select("locale, active_revision_id, active_version")
        .eq("locale", locale)
        .maybeSingle();
      handleSupabaseError(error, "Unable to load app-content locale state");
      return data;
    };

    let locale = requestedLocale;
    let stateData = await loadState(locale);
    const fallbackApplied = (!stateData || !stateData.active_revision_id || Number(stateData.active_version) <= 0)
      && requestedLocale !== APP_CONTENT_DEFAULT_LOCALE;
    if (fallbackApplied) {
      locale = APP_CONTENT_DEFAULT_LOCALE;
      stateData = await loadState(locale);
    }

    if (!stateData || !stateData.active_revision_id || Number(stateData.active_version) <= 0) {
      throw new ApiError(404, "Published app-content is not available for this locale");
    }

    const { data: revisionData, error: revisionError } = await supabaseAdmin
      .from("app_content_revisions")
      .select("id, locale, version, checksum, published_at")
      .eq("id", stateData.active_revision_id)
      .eq("locale", locale)
      .eq("version", stateData.active_version)
      .maybeSingle();
    handleSupabaseError(revisionError, "Unable to load published app-content revision");
    if (!revisionData) {
      throw new ApiError(503, "Published app-content revision is unavailable");
    }

    const { data: entryData, error: entryError } = await supabaseAdmin
      .from("app_content_revision_entries")
      .select("definition_key, value")
      .eq("revision_id", revisionData.id)
      .order("definition_key", { ascending: true });
    handleSupabaseError(entryError, "Unable to load published app-content entries");

    const content: Record<string, string> = {};
    for (const entry of (entryData ?? []) as unknown as RowList) {
      const key = String(entry.definition_key ?? "");
      const value = typeof entry.value === "string" ? entry.value : null;
      if (!key || value === null || Object.hasOwn(content, key)) {
        throw new ApiError(503, "Published app-content revision is malformed");
      }
      content[key] = value;
    }

    if (Object.keys(content).length === 0) {
      throw new ApiError(503, "Published app-content revision is malformed");
    }

    const revision = revisionData as unknown as Row;
    return {
      revisionId: String(revision.id),
      locale: String(revision.locale),
      requestedLocale,
      fallbackApplied,
      version: Number(revision.version),
      checksum: String(revision.checksum),
      publishedAt: String(revision.published_at),
      content
    };
  }
};
