import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { PaymentProvider } from "../validators/paymentMethodsValidators";
import { appointmentsService } from "./appointmentsService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { paymentMethodsService } from "./paymentMethodsService";

type MarkPaidPayload = {
  payment_method_id?: string | null;
  amount?: number;
  tip_amount?: number;
  external_provider?: PaymentProvider | null;
  external_provider_label?: string | null;
  external_reference?: string | null;
  notes?: string | null;
};

type UpdatePaymentPayload = Partial<MarkPaidPayload>;

const PAYMENT_NOTICE = "Payment is completed outside DripDesk. DripDesk does not process or verify this payment.";

const toNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const pickPaymentMethodSummary = (paymentMethod: Row | null): Row | null => {
  if (!paymentMethod) {
    return null;
  }

  return {
    id: paymentMethod.id,
    provider: paymentMethod.provider,
    display_name: paymentMethod.display_name
  };
};

const normalizePayment = (payment: Row, paymentMethod: Row | null): Row => {
  const amount = toNumber(payment.amount);
  const tipAmount = toNumber(payment.tip_amount);

  return {
    id: payment.id,
    appointment_id: payment.appointment_id,
    payment_method_id: payment.payment_method_id ?? null,
    status: payment.status,
    amount,
    tip_amount: tipAmount,
    total_recorded: toNumber(payment.total_recorded) || amount + tipAmount,
    external_provider: payment.external_provider ?? null,
    external_provider_label: payment.external_provider_label ?? null,
    external_reference: payment.external_reference ?? null,
    notes: payment.notes ?? null,
    marked_paid_at: payment.marked_paid_at ?? null,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
    payment_method: pickPaymentMethodSummary(paymentMethod),
    payment_notice: PAYMENT_NOTICE
  };
};

const getCurrentPaymentRecord = async (userId: string, appointmentId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("appointment_payments")
    .select("*")
    .eq("user_id", userId)
    .eq("appointment_id", appointmentId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load appointment payment");
  return data ?? null;
};

const resolvePaymentMethodSnapshot = async (
  userId: string,
  paymentMethodId: string | null | undefined,
  explicitProvider: PaymentProvider | null | undefined,
  explicitLabel: string | null | undefined
): Promise<{
  paymentMethod: Row | null;
  externalProvider: PaymentProvider | null;
  externalProviderLabel: string | null;
}> => {
  if (!paymentMethodId) {
    return {
      paymentMethod: null,
      externalProvider: explicitProvider ?? null,
      externalProviderLabel: explicitLabel ?? null
    };
  }

  const paymentMethod = await paymentMethodsService.getActiveOwned(userId, paymentMethodId);
  return {
    paymentMethod,
    externalProvider: paymentMethod.provider as PaymentProvider,
    externalProviderLabel: typeof paymentMethod.display_name === "string" ? paymentMethod.display_name : explicitLabel ?? null
  };
};

export const appointmentPaymentsService = {
  paymentNotice: PAYMENT_NOTICE,

  async get(userId: string, appointmentId: string): Promise<Row | null> {
    await appointmentsService.getOwned(userId, appointmentId);
    const payment = await getCurrentPaymentRecord(userId, appointmentId);

    if (!payment) {
      return null;
    }

    const paymentMethod = typeof payment.payment_method_id === "string"
      ? await paymentMethodsService.getOwned(userId, payment.payment_method_id)
      : null;

    return normalizePayment(payment, paymentMethod);
  },

  async markPaid(userId: string, appointmentId: string, payload: MarkPaidPayload, now = new Date()): Promise<Row> {
    const appointment = await appointmentsService.getOwned(userId, appointmentId);
    const { paymentMethod, externalProvider, externalProviderLabel } = await resolvePaymentMethodSnapshot(
      userId,
      payload.payment_method_id,
      payload.external_provider,
      payload.external_provider_label
    );
    const existing = await getCurrentPaymentRecord(userId, appointmentId);
    const amount = payload.amount ?? toNumber(appointment.price);
    const tipAmount = payload.tip_amount ?? 0;
    const paymentPayload = {
      user_id: userId,
      appointment_id: appointmentId,
      payment_method_id: payload.payment_method_id ?? null,
      status: "marked_paid",
      amount,
      tip_amount: tipAmount,
      external_provider: externalProvider,
      external_provider_label: externalProviderLabel,
      external_reference: payload.external_reference ?? null,
      notes: payload.notes ?? null,
      marked_paid_at: now.toISOString(),
      marked_unpaid_at: null,
      voided_at: null,
      is_current: true
    };

    const query = existing
      ? supabaseAdmin
        .from("appointment_payments")
        .update(paymentPayload)
        .eq("id", existing.id)
        .eq("user_id", userId)
        .select("*")
        .single()
      : supabaseAdmin
        .from("appointment_payments")
        .insert(paymentPayload)
        .select("*")
        .single();

    const { data, error } = await query;
    handleSupabaseError(error, "Unable to record appointment payment");
    return normalizePayment(requireFound(data, "Appointment payment was not recorded"), paymentMethod);
  },

  async markUnpaid(userId: string, appointmentId: string, now = new Date()): Promise<Row | null> {
    await appointmentsService.getOwned(userId, appointmentId);
    const existing = await getCurrentPaymentRecord(userId, appointmentId);

    if (!existing) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_payments")
      .update({
        status: "voided",
        is_current: false,
        marked_unpaid_at: now.toISOString(),
        voided_at: now.toISOString()
      })
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to void appointment payment record");
    return normalizePayment(requireFound(data, "Appointment payment was not voided"), null);
  },

  async update(userId: string, appointmentId: string, payload: UpdatePaymentPayload): Promise<Row> {
    await appointmentsService.getOwned(userId, appointmentId);
    const existing = await getCurrentPaymentRecord(userId, appointmentId);

    if (!existing) {
      throw new ApiError(404, "Appointment payment not found");
    }

    const nextPaymentMethodId = payload.payment_method_id !== undefined
      ? payload.payment_method_id
      : existing.payment_method_id as string | null | undefined;
    const { paymentMethod, externalProvider, externalProviderLabel } = await resolvePaymentMethodSnapshot(
      userId,
      nextPaymentMethodId,
      payload.external_provider !== undefined
        ? payload.external_provider
        : existing.external_provider as PaymentProvider | null | undefined,
      payload.external_provider_label !== undefined
        ? payload.external_provider_label
        : existing.external_provider_label as string | null | undefined
    );
    const { data, error } = await supabaseAdmin
      .from("appointment_payments")
      .update({
        payment_method_id: nextPaymentMethodId ?? null,
        amount: payload.amount ?? existing.amount,
        tip_amount: payload.tip_amount ?? existing.tip_amount,
        external_provider: externalProvider,
        external_provider_label: externalProviderLabel,
        external_reference: payload.external_reference !== undefined
          ? payload.external_reference
          : existing.external_reference,
        notes: payload.notes !== undefined ? payload.notes : existing.notes
      })
      .eq("id", existing.id)
      .eq("user_id", userId)
      .eq("is_current", true)
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to update appointment payment record");
    return normalizePayment(requireFound(data, "Appointment payment was not updated"), paymentMethod);
  }
};
