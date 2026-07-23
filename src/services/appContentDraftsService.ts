import { ApiError } from "../lib/errors";
import {
  type AppContentDefinitionContract,
  type AppContentValidationIssue,
  validateAppContentValue
} from "../lib/appContent";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

type DraftWriteInput = {
  locale: string;
  value: string;
  expectedDraftVersion: number | null;
  actorEmail: string;
  actorUserId: string;
};

type DefinitionCreateInput = Omit<AppContentDefinitionContract, "isActive" | "developerNotes"> & {
  developerNotes?: string | null;
  actorEmail: string;
};

type DefinitionUpdateInput = Partial<Pick<
  AppContentDefinitionContract,
  "category" | "description" | "allowedPlaceholders" | "maxLength" | "multilineAllowed" | "isActive" | "fallbackRequired" | "developerNotes"
>> & { actorEmail: string };

const definitionSelect = [
  "key", "namespace", "category", "description", "allowed_placeholders", "max_length",
  "multiline_allowed", "is_active", "fallback_required", "developer_notes"
].join(", ");

const draftSelect = [
  "definition_key", "locale", "value", "draft_version", "validation_status", "validation_errors",
  "updated_by_admin_email", "updated_by_user_id", "created_at", "updated_at"
].join(", ");

const toDefinition = (row: Row): AppContentDefinitionContract => ({
  key: String(row.key),
  namespace: String(row.namespace),
  category: row.category as AppContentDefinitionContract["category"],
  description: String(row.description),
  allowedPlaceholders: Array.isArray(row.allowed_placeholders) ? row.allowed_placeholders.map(String) : [],
  maxLength: Number(row.max_length),
  multilineAllowed: row.multiline_allowed === true,
  isActive: row.is_active === true,
  fallbackRequired: row.fallback_required === true,
  developerNotes: typeof row.developer_notes === "string" ? row.developer_notes : null
});

const toDraft = (row: Row) => ({
  key: String(row.definition_key),
  locale: String(row.locale),
  value: String(row.value),
  draft_version: Number(row.draft_version),
  validation_status: String(row.validation_status),
  validation_errors: row.validation_errors ?? null,
  updated_by_admin_email: String(row.updated_by_admin_email),
  updated_by_user_id: row.updated_by_user_id ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at
});

const toValidationResponse = (
  definition: AppContentDefinitionContract,
  value: string
): { valid: boolean; normalized_value: string; placeholders: string[]; issues: AppContentValidationIssue[] } => {
  const result = validateAppContentValue(value, definition);
  return {
    valid: result.issues.length === 0,
    normalized_value: result.value,
    placeholders: result.placeholders,
    issues: result.issues
  };
};

const getDefinition = async (key: string): Promise<AppContentDefinitionContract> => {
  const { data, error } = await supabaseAdmin
    .from("app_content_definitions")
    .select(definitionSelect)
    .eq("key", key)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load app-content definition");
  if (!data) throw new ApiError(404, "App-content definition not found");
  return toDefinition(data as unknown as Row);
};

const assertActiveDefinition = (definition: AppContentDefinitionContract): void => {
  if (!definition.isActive) {
    throw new ApiError(409, "App-content definition is archived");
  }
};

const assertValidDraftValue = (
  definition: AppContentDefinitionContract,
  value: string
): { normalizedValue: string } => {
  const validation = toValidationResponse(definition, value);
  if (!validation.valid) {
    throw new ApiError(400, "Invalid app-content draft value", {
      issues: validation.issues
    }, { exposeDetails: true });
  }

  return { normalizedValue: validation.normalized_value };
};

export const appContentDraftsService = {
  async listDefinitions(input: { namespace?: string; status: "active" | "inactive" | "all"; limit: number; offset: number }) {
    let query = supabaseAdmin
      .from("app_content_definitions")
      .select(definitionSelect, { count: "exact" })
      .order("namespace", { ascending: true })
      .order("key", { ascending: true })
      .range(input.offset, input.offset + input.limit - 1);

    if (input.namespace) query = query.eq("namespace", input.namespace);
    if (input.status !== "all") query = query.eq("is_active", input.status === "active");

    const { data, error, count } = await query;
    handleSupabaseError(error, "Unable to load app-content definitions");
    return {
      data: ((data ?? []) as unknown as RowList).map(toDefinition),
      page: { limit: input.limit, offset: input.offset, total: count ?? 0 }
    };
  },

  async createDefinition(input: DefinitionCreateInput) {
    const { data, error } = await supabaseAdmin
      .from("app_content_definitions")
      .insert({
        key: input.key,
        namespace: input.namespace,
        category: input.category,
        description: input.description,
        allowed_placeholders: input.allowedPlaceholders,
        max_length: input.maxLength,
        multiline_allowed: input.multilineAllowed,
        fallback_required: input.fallbackRequired,
        developer_notes: input.developerNotes ?? null,
        created_by_admin_email: input.actorEmail,
        updated_by_admin_email: input.actorEmail
      })
      .select(definitionSelect)
      .single();

    if (error?.code === "23505") throw new ApiError(409, "An app-content definition already uses this key");
    handleSupabaseError(error, "Unable to create app-content definition");
    return toDefinition(data as unknown as Row);
  },

  async updateDefinition(key: string, input: DefinitionUpdateInput) {
    const definition = await getDefinition(key);
    const payload: Row = { updated_by_admin_email: input.actorEmail };
    if (input.category !== undefined) payload.category = input.category;
    if (input.description !== undefined) payload.description = input.description;
    if (input.allowedPlaceholders !== undefined) payload.allowed_placeholders = input.allowedPlaceholders;
    if (input.maxLength !== undefined) payload.max_length = input.maxLength;
    if (input.multilineAllowed !== undefined) payload.multiline_allowed = input.multilineAllowed;
    if (input.isActive !== undefined) payload.is_active = input.isActive;
    if (input.fallbackRequired !== undefined) payload.fallback_required = input.fallbackRequired;
    if (input.developerNotes !== undefined) payload.developer_notes = input.developerNotes;

    const { data, error } = await supabaseAdmin
      .from("app_content_definitions")
      .update(payload)
      .eq("key", definition.key)
      .select(definitionSelect)
      .single();

    handleSupabaseError(error, "Unable to update app-content definition");
    return toDefinition(data as unknown as Row);
  },

  async getDraft(key: string, locale: string) {
    const definition = await getDefinition(key);
    const { data, error } = await supabaseAdmin
      .from("app_content_drafts")
      .select(draftSelect)
      .eq("definition_key", definition.key)
      .eq("locale", locale)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load app-content draft");
    return { definition, draft: data ? toDraft(data as unknown as Row) : null };
  },

  async listDrafts(input: { locale: string; namespace?: string; status: "active" | "inactive" | "all"; limit: number; offset: number }) {
    const definitions = await this.listDefinitions({
      namespace: input.namespace,
      status: input.status,
      limit: input.limit,
      offset: input.offset
    });
    const keys = definitions.data.map((definition) => definition.key);
    if (keys.length === 0) return { ...definitions, locale: input.locale, data: [] };

    const { data, error } = await supabaseAdmin
      .from("app_content_drafts")
      .select(draftSelect)
      .eq("locale", input.locale)
      .in("definition_key", keys);
    handleSupabaseError(error, "Unable to load app-content drafts");
    const draftsByKey = new Map(((data ?? []) as unknown as RowList).map((row) => {
      const draft = toDraft(row);
      return [draft.key, draft] as const;
    }));

    return {
      locale: input.locale,
      data: definitions.data.map((definition) => ({ definition, draft: draftsByKey.get(definition.key) ?? null })),
      page: definitions.page
    };
  },

  async putDraft(key: string, input: DraftWriteInput) {
    const definition = await getDefinition(key);
    assertActiveDefinition(definition);
    const { normalizedValue } = assertValidDraftValue(definition, input.value);

    const { data: existingData, error: existingError } = await supabaseAdmin
      .from("app_content_drafts")
      .select(draftSelect)
      .eq("definition_key", definition.key)
      .eq("locale", input.locale)
      .maybeSingle();
    handleSupabaseError(existingError, "Unable to load app-content draft");

    const existing = existingData ? toDraft(existingData as unknown as Row) : null;
    if (!existing && input.expectedDraftVersion !== null) {
      throw new ApiError(409, "App-content draft was updated elsewhere", { current_draft_version: null }, { exposeDetails: true });
    }
    if (existing && input.expectedDraftVersion !== existing.draft_version) {
      throw new ApiError(409, "App-content draft was updated elsewhere", {
        current_draft_version: existing.draft_version
      }, { exposeDetails: true });
    }

    if (!existing) {
      const { data, error } = await supabaseAdmin
        .from("app_content_drafts")
        .insert({
          definition_key: definition.key,
          locale: input.locale,
          value: normalizedValue,
          draft_version: 1,
          validation_status: "valid",
          validation_errors: null,
          updated_by_admin_email: input.actorEmail,
          updated_by_user_id: input.actorUserId
        })
        .select(draftSelect)
        .single();
      if (error?.code === "23505") {
        throw new ApiError(409, "App-content draft was created elsewhere", { current_draft_version: null }, { exposeDetails: true });
      }
      handleSupabaseError(error, "Unable to create app-content draft");
      return { definition, draft: toDraft(data as unknown as Row) };
    }

    const { data, error } = await supabaseAdmin
      .from("app_content_drafts")
      .update({
        value: normalizedValue,
        draft_version: existing.draft_version + 1,
        validation_status: "valid",
        validation_errors: null,
        updated_by_admin_email: input.actorEmail,
        updated_by_user_id: input.actorUserId
      })
      .eq("definition_key", definition.key)
      .eq("locale", input.locale)
      .eq("draft_version", existing.draft_version)
      .select(draftSelect)
      .maybeSingle();

    handleSupabaseError(error, "Unable to update app-content draft");
    if (!data) {
      throw new ApiError(409, "App-content draft was updated elsewhere", {
        current_draft_version: existing.draft_version
      }, { exposeDetails: true });
    }

    return { definition, draft: toDraft(data as unknown as Row) };
  },

  async validateDrafts(input: { locale: string; key?: string }) {
    let definitionQuery = supabaseAdmin
      .from("app_content_definitions")
      .select(definitionSelect)
      .eq("is_active", true)
      .order("key", { ascending: true });
    if (input.key) definitionQuery = definitionQuery.eq("key", input.key);

    const { data: definitionData, error: definitionError } = await definitionQuery;
    handleSupabaseError(definitionError, "Unable to load app-content definitions");
    const definitions = ((definitionData ?? []) as unknown as RowList).map(toDefinition);
    if (input.key && definitions.length === 0) throw new ApiError(404, "App-content definition not found");

    const { data: draftData, error: draftError } = await supabaseAdmin
      .from("app_content_drafts")
      .select(draftSelect)
      .eq("locale", input.locale);
    handleSupabaseError(draftError, "Unable to load app-content drafts");
    const drafts = new Map(((draftData ?? []) as unknown as RowList).map((row) => {
      const draft = toDraft(row);
      return [draft.key, draft] as const;
    }));

    return {
      locale: input.locale,
      results: definitions.map((definition) => {
        const draft = drafts.get(definition.key);
        if (!draft) {
          return {
            key: definition.key,
            valid: false,
            issues: [{ code: "blank", message: "No draft exists for this active content key" }]
          };
        }
        return { key: definition.key, draft_version: draft.draft_version, ...toValidationResponse(definition, draft.value) };
      })
    };
  }
};
