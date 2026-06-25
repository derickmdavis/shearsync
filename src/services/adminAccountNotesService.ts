import { ApiError } from "../lib/errors";
import { sanitizeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row, type RowList } from "./db";

export const adminAccountNotesService = {
  async listNotes(accountUserId: string): Promise<RowList> {
    const { data, error } = await supabaseAdmin
      .from("admin_account_notes")
      .select("*")
      .eq("account_user_id", accountUserId)
      .order("created_at", { ascending: false });

    handleSupabaseError(error, "Unable to load admin account notes");
    return (data ?? []) as RowList;
  },

  async createNote(input: {
    accountUserId: string;
    createdByAdminEmail: string;
    note: string;
    metadata?: unknown;
  }): Promise<Row> {
    const note = input.note.trim();
    if (!note) {
      throw new ApiError(400, "Admin note cannot be empty");
    }

    const { data, error } = await supabaseAdmin
      .from("admin_account_notes")
      .insert({
        account_user_id: input.accountUserId,
        created_by_admin_email: input.createdByAdminEmail,
        note,
        metadata: sanitizeMetadata(input.metadata ?? {})
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create admin account note");
    return data as Row;
  }
};
