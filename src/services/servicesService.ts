import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { ServiceCatalogItem } from "../types/api";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { stylistsService } from "./stylistsService";

interface ServiceRow extends Row {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  category: string | null;
  duration_minutes: number;
  price: number | string;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
  created_at?: string;
}

interface ServiceCatalogCreateInput {
  name: string;
  duration: number;
  price: number;
  visible: boolean;
  category?: string;
  description?: string;
  isDefault?: boolean;
  sortOrder?: number;
}

type ServiceCatalogUpdateInput = Partial<ServiceCatalogCreateInput>;

const SERVICE_SELECT =
  "id, user_id, name, description, category, duration_minutes, price, is_active, is_default, sort_order, created_at";

const toServiceCatalogItem = (row: ServiceRow): ServiceCatalogItem => ({
  id: row.id,
  name: row.name,
  duration: row.duration_minutes,
  durationMinutes: row.duration_minutes,
  price: Number(row.price),
  priceAmount: Number(row.price),
  visible: row.is_active,
  category: row.category ?? undefined,
  description: row.description ?? undefined,
  isDefault: row.is_default,
  sortOrder: row.sort_order
});

const getNextSortOrder = async (userId: string): Promise<number> => {
  const { data, error } = await supabaseAdmin
    .from("services")
    .select("sort_order")
    .eq("user_id", userId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  handleSupabaseError(error, "Unable to determine service order");
  const currentMax = typeof data?.sort_order === "number" ? data.sort_order : 0;
  return currentMax + 1;
};

export const servicesService = {
  async listActiveByStylistSlug(slug: string): Promise<RowList> {
    const stylist = await stylistsService.getBySlug(slug);

    const { data, error } = await supabaseAdmin
      .from("services")
      .select("*")
      .eq("user_id", stylist.user_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .order("name", { ascending: true });

    handleSupabaseError(error, "Unable to load services");
    return data ?? [];
  },

  async getActiveForStylist(userId: string, serviceId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("services")
      .select("*")
      .eq("id", serviceId)
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load service");
    return data;
  },

  async listByUserId(userId: string): Promise<ServiceCatalogItem[]> {
    const { data, error } = await supabaseAdmin
      .from("services")
      .select(SERVICE_SELECT)
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .order("name", { ascending: true });

    handleSupabaseError(error, "Unable to load services");
    return (data ?? []).map((row) => toServiceCatalogItem(row as ServiceRow));
  },

  async listActiveByUserId(userId: string): Promise<RowList> {
    const { data, error } = await supabaseAdmin
      .from("services")
      .select("*")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .order("name", { ascending: true });

    handleSupabaseError(error, "Unable to load services");
    return data ?? [];
  },

  async create(userId: string, payload: ServiceCatalogCreateInput): Promise<ServiceCatalogItem> {
    const sortOrder = payload.sortOrder ?? (await getNextSortOrder(userId));
    const { data, error } = await supabaseAdmin
      .from("services")
      .insert({
        user_id: userId,
        name: payload.name,
        description: payload.description,
        category: payload.category,
        duration_minutes: payload.duration,
        price: payload.price,
        is_active: payload.visible,
        is_default: payload.isDefault ?? false,
        sort_order: sortOrder
      })
      .select(SERVICE_SELECT)
      .single();

    handleSupabaseError(error, "Unable to create service");
    return toServiceCatalogItem(requireFound(data as ServiceRow | null, "Service was not created"));
  },

  async update(userId: string, serviceId: string, payload: ServiceCatalogUpdateInput): Promise<ServiceCatalogItem> {
    const updates: Row = {};

    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.duration !== undefined) updates.duration_minutes = payload.duration;
    if (payload.price !== undefined) updates.price = payload.price;
    if (payload.visible !== undefined) updates.is_active = payload.visible;
    if (payload.category !== undefined) updates.category = payload.category;
    if (payload.description !== undefined) updates.description = payload.description;
    if (payload.isDefault !== undefined) updates.is_default = payload.isDefault;
    if (payload.sortOrder !== undefined) updates.sort_order = payload.sortOrder;

    if (Object.keys(updates).length === 0) {
      const { data, error } = await supabaseAdmin
        .from("services")
        .select(SERVICE_SELECT)
        .eq("id", serviceId)
        .eq("user_id", userId)
        .maybeSingle();

      handleSupabaseError(error, "Unable to load service");
      return toServiceCatalogItem(requireFound(data as ServiceRow | null, "Service not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("services")
      .update(updates)
      .eq("id", serviceId)
      .eq("user_id", userId)
      .select(SERVICE_SELECT)
      .maybeSingle();

    handleSupabaseError(error, "Unable to update service");
    return toServiceCatalogItem(requireFound(data as ServiceRow | null, "Service not found"));
  },

  async delete(userId: string, serviceId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from("services")
      .delete()
      .eq("id", serviceId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    handleSupabaseError(error, "Unable to delete service");
    requireFound(data, "Service not found");
  },

  async reorder(userId: string, serviceIds: string[]): Promise<ServiceCatalogItem[]> {
    const uniqueServiceIds = [...new Set(serviceIds)];

    if (uniqueServiceIds.length !== serviceIds.length) {
      throw new ApiError(400, "serviceIds must not contain duplicates");
    }

    const ownedServiceCount = await this.countOwnedByIds(userId, uniqueServiceIds);

    if (ownedServiceCount !== uniqueServiceIds.length) {
      throw new ApiError(400, "serviceIds must all belong to services owned by the authenticated user");
    }

    await Promise.all(
      uniqueServiceIds.map((serviceId, index) =>
        supabaseAdmin
          .from("services")
          .update({ sort_order: index + 1 })
          .eq("id", serviceId)
          .eq("user_id", userId)
      )
    );

    return this.listByUserId(userId);
  },

  async countOwnedByIds(userId: string, serviceIds: string[]): Promise<number> {
    if (serviceIds.length === 0) {
      return 0;
    }

    const uniqueServiceIds = [...new Set(serviceIds)];
    const { count, error } = await supabaseAdmin
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("id", uniqueServiceIds);

    handleSupabaseError(error, "Unable to verify services");
    return count ?? 0;
  },

  async assertOwned(userId: string, serviceId: string): Promise<void> {
    const count = await this.countOwnedByIds(userId, [serviceId]);

    if (count !== 1) {
      throw new ApiError(400, "Service does not belong to the authenticated user");
    }
  }
};
