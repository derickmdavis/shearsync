import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { PaymentProvider } from "../validators/paymentMethodsValidators";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { paymentMethodQrStorageService } from "./paymentMethodQrStorageService";
import { recordProductTelemetry } from "./productTelemetry";

type PaymentMethodPayload = {
  provider: PaymentProvider;
  display_name: string;
  payment_url?: string | null;
  qr_image_url?: string | null;
  qr_image_path?: string | null;
  instructions?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  sort_order?: number;
};

type PaymentMethodUpdatePayload = Partial<PaymentMethodPayload>;

type ReorderPaymentMethodItem = {
  id: string;
  sort_order: number;
};

const isCashLikeProvider = (provider: unknown): boolean => provider === "cash" || provider === "other";

const hasExternalPaymentTarget = (method: Row): boolean =>
  isCashLikeProvider(method.provider)
  || Boolean(method.payment_url)
  || Boolean(method.qr_image_url)
  || Boolean(method.qr_image_path);

const normalizePaymentMethod = (method: Row): Row => ({
  ...method,
  payment_notice: "Payment is completed outside DripDesk. DripDesk does not process or verify this payment."
});

const normalizePaymentMethods = (methods: RowList): RowList => methods.map(normalizePaymentMethod);

const withoutUndefined = (value: Row): Row =>
  Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));

export const paymentMethodsService = {
  async list(userId: string, includeInactive = false): Promise<RowList> {
    let query = supabaseAdmin
      .from("payment_methods")
      .select("*")
      .eq("user_id", userId);

    if (!includeInactive) {
      query = query.eq("is_active", true);
    }

    const { data, error } = await query
      .order("is_default", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    handleSupabaseError(error, "Unable to load payment shortcuts");
    return normalizePaymentMethods(data ?? []);
  },

  async getOwned(userId: string, paymentMethodId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("payment_methods")
      .select("*")
      .eq("id", paymentMethodId)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load payment shortcut");
    return requireFound(data, "Payment shortcut not found");
  },

  async getActiveOwned(userId: string, paymentMethodId: string): Promise<Row> {
    const method = await this.getOwned(userId, paymentMethodId);

    if (method.is_active !== true) {
      throw new ApiError(400, "Payment shortcut is inactive");
    }

    return method;
  },

  async unsetActiveDefaults(userId: string, exceptId?: string): Promise<void> {
    let query = supabaseAdmin
      .from("payment_methods")
      .update({ is_default: false })
      .eq("user_id", userId)
      .eq("is_active", true)
      .eq("is_default", true);

    if (exceptId) {
      query = query.neq("id", exceptId);
    }

    const { error } = await query.select("id");
    handleSupabaseError(error, "Unable to update payment shortcut defaults");
  },

  async create(userId: string, payload: PaymentMethodPayload): Promise<Row> {
    paymentMethodQrStorageService.assertQrPathMatches(userId, payload.qr_image_path);

    if (payload.is_default === true) {
      await this.unsetActiveDefaults(userId);
    }

    const isActive = payload.is_active ?? true;
    const { data, error } = await supabaseAdmin
      .from("payment_methods")
      .insert({
        user_id: userId,
        provider: payload.provider,
        display_name: payload.display_name,
        payment_url: payload.payment_url ?? null,
        qr_image_url: payload.qr_image_url ?? null,
        qr_image_path: payload.qr_image_path ?? null,
        instructions: payload.instructions ?? null,
        is_default: isActive ? payload.is_default === true : false,
        is_active: isActive,
        sort_order: payload.sort_order ?? 0
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create payment shortcut");
    const method = normalizePaymentMethod(requireFound(data, "Payment shortcut was not created"));
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      eventType: "payment_shortcut_created",
      eventSource: "backend",
      dedupeKey: typeof method.id === "string" ? `payment_shortcut_created:${method.id}` : null,
      metadata: {
        provider: method.provider ?? null,
        has_payment_url: Boolean(method.payment_url),
        has_qr_image_url: Boolean(method.qr_image_url),
        has_qr_image_path: Boolean(method.qr_image_path),
        is_default: method.is_default === true
      }
    });
    return method;
  },

  async update(userId: string, paymentMethodId: string, updates: PaymentMethodUpdatePayload): Promise<Row> {
    if (updates.qr_image_path !== undefined) {
      paymentMethodQrStorageService.assertQrPathMatches(userId, updates.qr_image_path);
    }

    const existing = await this.getOwned(userId, paymentMethodId);
    const merged = {
      ...existing,
      ...updates
    };

    if (!hasExternalPaymentTarget(merged)) {
      throw new ApiError(400, "At least one payment URL or QR image is required unless provider is cash or other");
    }

    const nextIsActive = updates.is_active ?? existing.is_active;
    const nextIsDefault = nextIsActive === false ? false : updates.is_default ?? existing.is_default;

    if (updates.is_default === true && nextIsActive !== false) {
      await this.unsetActiveDefaults(userId, paymentMethodId);
    }

    const { data, error } = await supabaseAdmin
      .from("payment_methods")
      .update(withoutUndefined({
        ...updates,
        is_default: nextIsDefault
      }))
      .eq("id", paymentMethodId)
      .eq("user_id", userId)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to update payment shortcut");
    const method = normalizePaymentMethod(requireFound(data, "Payment shortcut was not updated"));
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      eventType: method.is_active === false ? "payment_shortcut_disabled" : "payment_shortcut_updated",
      eventSource: "backend",
      metadata: {
        provider: method.provider ?? null,
        has_payment_url: Boolean(method.payment_url),
        has_qr_image_url: Boolean(method.qr_image_url),
        has_qr_image_path: Boolean(method.qr_image_path),
        updated_fields: Object.keys(updates).filter((field) => !["payment_url", "qr_image_url", "qr_image_path", "instructions"].includes(field))
      }
    });
    return method;
  },

  async remove(userId: string, paymentMethodId: string): Promise<Row> {
    await this.getOwned(userId, paymentMethodId);

    const { data, error } = await supabaseAdmin
      .from("payment_methods")
      .update({
        is_active: false,
        is_default: false
      })
      .eq("id", paymentMethodId)
      .eq("user_id", userId)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to deactivate payment shortcut");
    const method = normalizePaymentMethod(requireFound(data, "Payment shortcut was not deactivated"));
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      eventType: "payment_shortcut_disabled",
      eventSource: "backend",
      metadata: {
        provider: method.provider ?? null,
        has_payment_url: Boolean(method.payment_url),
        has_qr_image_url: Boolean(method.qr_image_url),
        has_qr_image_path: Boolean(method.qr_image_path)
      }
    });
    return method;
  },

  async reorder(userId: string, items: ReorderPaymentMethodItem[]): Promise<RowList> {
    const ids = items.map((item) => item.id);
    const { data: ownedMethods, error } = await supabaseAdmin
      .from("payment_methods")
      .select("id")
      .eq("user_id", userId)
      .in("id", ids);

    handleSupabaseError(error, "Unable to load payment shortcuts for reorder");

    if ((ownedMethods ?? []).length !== ids.length) {
      throw new ApiError(404, "Payment shortcut not found");
    }

    const updatedMethods: RowList = [];
    for (const item of items) {
      const { data, error: updateError } = await supabaseAdmin
        .from("payment_methods")
        .update({ sort_order: item.sort_order })
        .eq("id", item.id)
        .eq("user_id", userId)
        .select("*")
        .single();

      handleSupabaseError(updateError, "Unable to reorder payment shortcuts");
      updatedMethods.push(requireFound(data, "Payment shortcut was not reordered"));
    }

    return normalizePaymentMethods(updatedMethods);
  },

  async createQrUploadIntent(userId: string, payload: {
    content_type: string;
    size_bytes: number;
  }) {
    return paymentMethodQrStorageService.createUploadIntent(userId, payload);
  }
};
