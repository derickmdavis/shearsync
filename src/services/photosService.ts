import { requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { clientsService } from "./clientsService";

export const photosService = {
  async listByClient(userId: string, clientId: string): Promise<RowList> {
    await clientsService.assertOwned(userId, clientId);

    const { data, error } = await supabaseAdmin
      .from("photos")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    handleSupabaseError(error, "Unable to load photos");
    return data ?? [];
  },

  async create(userId: string, payload: Row): Promise<Row> {
    await clientsService.assertOwned(userId, payload.client_id as string);

    const { data, error } = await supabaseAdmin
      .from("photos")
      .insert({ ...payload, user_id: userId })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create photo metadata");
    return requireFound(data, "Photo metadata was not created");
  }
};

