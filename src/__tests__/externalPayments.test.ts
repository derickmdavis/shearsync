import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { supabaseAdmin } = require("../lib/supabase") as typeof import("../lib/supabase");
const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { appointmentPaymentsService } =
  require("../services/appointmentPaymentsService") as typeof import("../services/appointmentPaymentsService");
const { paymentMethodsService } =
  require("../services/paymentMethodsService") as typeof import("../services/paymentMethodsService");
const { qrUploadIntentSchema, createPaymentMethodSchema } =
  require("../validators/paymentMethodsValidators") as typeof import("../validators/paymentMethodsValidators");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPOINTMENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_APPOINTMENT_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_METHOD_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_PAYMENT_METHOD_ID = "77777777-7777-4777-8777-777777777777";

const baseState = () => ({
  users: [
    { id: USER_ID, email: "stylist@example.com" },
    { id: OTHER_USER_ID, email: "other@example.com" }
  ],
  clients: [
    { id: CLIENT_ID, user_id: USER_ID, first_name: "Ari", last_name: "Client" }
  ],
  appointments: [
    {
      id: APPOINTMENT_ID,
      user_id: USER_ID,
      client_id: CLIENT_ID,
      appointment_date: "2026-06-23T18:00:00.000Z",
      service_name: "Cut",
      duration_minutes: 45,
      price: 85,
      status: "scheduled"
    },
    {
      id: OTHER_APPOINTMENT_ID,
      user_id: OTHER_USER_ID,
      client_id: CLIENT_ID,
      appointment_date: "2026-06-24T18:00:00.000Z",
      service_name: "Color",
      duration_minutes: 90,
      price: 200,
      status: "scheduled"
    }
  ],
  payment_methods: [] as Record<string, unknown>[],
  appointment_payments: [] as Record<string, unknown>[]
});

const installStorageMock = () => {
  const calls = {
    bucket: [] as string[],
    createSignedUploadUrl: [] as string[]
  };
  const fromMock = mock.method(supabaseAdmin.storage, "from", (bucket: string) => {
    calls.bucket.push(bucket);
    return {
      createSignedUploadUrl: async (path: string) => {
        calls.createSignedUploadUrl.push(path);
        return {
          data: {
            signedUrl: `https://example.supabase.co/upload/${path}?token=test`,
            token: "test",
            path
          },
          error: null
        };
      }
    };
  });

  return {
    calls,
    restore: () => fromMock.mock.restore()
  };
};

describe("external payment shortcuts", () => {
  it("allows an authenticated user to create a Venmo payment shortcut with a URL", async () => {
    const db = installMockSupabase(baseState());

    try {
      const method = await paymentMethodsService.create(USER_ID, {
        provider: "venmo",
        display_name: "Venmo",
        payment_url: "https://venmo.com/example"
      });

      assert.equal(method.user_id, USER_ID);
      assert.equal(method.provider, "venmo");
      assert.equal(method.display_name, "Venmo");
      assert.equal(method.payment_url, "https://venmo.com/example");
      assert.match(String(method.payment_notice), /does not process or verify/);
    } finally {
      db.restore();
    }
  });

  it("allows an authenticated user to create a payment shortcut with a QR image path", async () => {
    const db = installMockSupabase(baseState());

    try {
      const method = await paymentMethodsService.create(USER_ID, {
        provider: "zelle",
        display_name: "Zelle QR",
        qr_image_path: "payment-method-qrs/11111111-1111-4111-8111-111111111111/qr.png"
      });

      assert.equal(method.provider, "zelle");
      assert.equal(method.qr_image_path, "payment-method-qrs/11111111-1111-4111-8111-111111111111/qr.png");
    } finally {
      db.restore();
    }
  });

  it("rejects payment shortcut creation without a link or QR unless provider is cash or other", () => {
    assert.throws(
      () => createPaymentMethodSchema.parse({
        provider: "venmo",
        display_name: "Venmo"
      }),
      /At least one payment URL or QR image/
    );

    assert.equal(createPaymentMethodSchema.parse({
      provider: "cash",
      display_name: "Cash"
    }).provider, "cash");
  });

  it("does not allow access to another user's payment shortcut", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: OTHER_PAYMENT_METHOD_ID,
      user_id: OTHER_USER_ID,
      provider: "paypal",
      display_name: "Other PayPal",
      payment_url: "https://paypal.me/other",
      is_active: true,
      is_default: false,
      sort_order: 0
    });
    const db = installMockSupabase(state);

    try {
      await assert.rejects(
        () => paymentMethodsService.getOwned(USER_ID, OTHER_PAYMENT_METHOD_ID),
        /Payment shortcut not found/
      );
    } finally {
      db.restore();
    }
  });

  it("setting one method as default unsets the previous active default", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "venmo",
      display_name: "Old default",
      payment_url: "https://venmo.com/old",
      is_active: true,
      is_default: true,
      sort_order: 0
    });
    const db = installMockSupabase(state);

    try {
      const method = await paymentMethodsService.create(USER_ID, {
        provider: "paypal",
        display_name: "New default",
        payment_url: "https://paypal.me/new",
        is_default: true
      });

      assert.equal(method.is_default, true);
      assert.equal(db.state.payment_methods.find((row) => row.id === PAYMENT_METHOD_ID)?.is_default, false);
    } finally {
      db.restore();
    }
  });

  it("deleting a payment shortcut soft-deactivates it and clears default", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "venmo",
      display_name: "Venmo",
      payment_url: "https://venmo.com/example",
      is_active: true,
      is_default: true,
      sort_order: 0
    });
    const db = installMockSupabase(state);

    try {
      const method = await paymentMethodsService.remove(USER_ID, PAYMENT_METHOD_ID);
      assert.equal(method.is_active, false);
      assert.equal(method.is_default, false);
    } finally {
      db.restore();
    }
  });

  it("payment methods list excludes inactive by default", async () => {
    const state = baseState();
    state.payment_methods.push(
      {
        id: PAYMENT_METHOD_ID,
        user_id: USER_ID,
        provider: "venmo",
        display_name: "Active",
        payment_url: "https://venmo.com/example",
        is_active: true,
        is_default: false,
        sort_order: 0,
        created_at: "2026-06-01T00:00:00.000Z"
      },
      {
        id: OTHER_PAYMENT_METHOD_ID,
        user_id: USER_ID,
        provider: "paypal",
        display_name: "Inactive",
        payment_url: "https://paypal.me/example",
        is_active: false,
        is_default: false,
        sort_order: 1,
        created_at: "2026-06-02T00:00:00.000Z"
      }
    );
    const db = installMockSupabase(state);

    try {
      const methods = await paymentMethodsService.list(USER_ID);
      assert.deepEqual(methods.map((method) => method.display_name), ["Active"]);
    } finally {
      db.restore();
    }
  });

  it("payment methods list includes inactive when requested", async () => {
    const state = baseState();
    state.payment_methods.push(
      {
        id: PAYMENT_METHOD_ID,
        user_id: USER_ID,
        provider: "venmo",
        display_name: "Active",
        payment_url: "https://venmo.com/example",
        is_active: true,
        is_default: false,
        sort_order: 0,
        created_at: "2026-06-01T00:00:00.000Z"
      },
      {
        id: OTHER_PAYMENT_METHOD_ID,
        user_id: USER_ID,
        provider: "paypal",
        display_name: "Inactive",
        payment_url: "https://paypal.me/example",
        is_active: false,
        is_default: false,
        sort_order: 1,
        created_at: "2026-06-02T00:00:00.000Z"
      }
    );
    const db = installMockSupabase(state);

    try {
      const methods = await paymentMethodsService.list(USER_ID, true);
      assert.deepEqual(methods.map((method) => method.display_name), ["Active", "Inactive"]);
    } finally {
      db.restore();
    }
  });

  it("allows an authenticated user to mark their own appointment as paid", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "venmo",
      display_name: "Venmo",
      payment_url: "https://venmo.com/example",
      is_active: true,
      is_default: false,
      sort_order: 0
    });
    const db = installMockSupabase(state);

    try {
      const payment = await appointmentPaymentsService.markPaid(USER_ID, APPOINTMENT_ID, {
        payment_method_id: PAYMENT_METHOD_ID,
        amount: 100,
        tip_amount: 20,
        external_reference: "manual-note"
      });

      assert.equal(payment.status, "marked_paid");
      assert.equal(payment.amount, 100);
      assert.equal(payment.tip_amount, 20);
      assert.equal(payment.total_recorded, 120);
      assert.equal(payment.external_provider, "venmo");
      assert.equal(payment.external_provider_label, "Venmo");
      assert.equal((payment.payment_method as { id?: string }).id, PAYMENT_METHOD_ID);
    } finally {
      db.restore();
    }
  });

  it("mark paid defaults amount from appointment price when amount is omitted", async () => {
    const db = installMockSupabase(baseState());

    try {
      const payment = await appointmentPaymentsService.markPaid(USER_ID, APPOINTMENT_ID, {
        external_provider: "cash",
        external_provider_label: "Cash"
      });

      assert.equal(payment.amount, 85);
      assert.equal(payment.tip_amount, 0);
      assert.equal(payment.total_recorded, 85);
    } finally {
      db.restore();
    }
  });

  it("does not allow marking another user's appointment as paid", async () => {
    const db = installMockSupabase(baseState());

    try {
      await assert.rejects(
        () => appointmentPaymentsService.markPaid(USER_ID, OTHER_APPOINTMENT_ID, { amount: 25 }),
        /Appointment not found/
      );
    } finally {
      db.restore();
    }
  });

  it("does not allow another user's payment method on mark paid", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: OTHER_PAYMENT_METHOD_ID,
      user_id: OTHER_USER_ID,
      provider: "paypal",
      display_name: "Other PayPal",
      payment_url: "https://paypal.me/other",
      is_active: true,
      is_default: false,
      sort_order: 0
    });
    const db = installMockSupabase(state);

    try {
      await assert.rejects(
        () => appointmentPaymentsService.markPaid(USER_ID, APPOINTMENT_ID, {
          payment_method_id: OTHER_PAYMENT_METHOD_ID,
          amount: 50
        }),
        /Payment shortcut not found/
      );
    } finally {
      db.restore();
    }
  });

  it("mark unpaid voids the current payment record and preserves history", async () => {
    const state = baseState();
    state.appointment_payments.push({
      id: "88888888-8888-4888-8888-888888888888",
      user_id: USER_ID,
      appointment_id: APPOINTMENT_ID,
      payment_method_id: null,
      status: "marked_paid",
      amount: 85,
      tip_amount: 0,
      total_recorded: 85,
      external_provider: "cash",
      external_provider_label: "Cash",
      is_current: true,
      marked_paid_at: "2026-06-22T10:00:00.000Z",
      created_at: "2026-06-22T10:00:00.000Z",
      updated_at: "2026-06-22T10:00:00.000Z"
    });
    const db = installMockSupabase(state);

    try {
      const payment = await appointmentPaymentsService.markUnpaid(USER_ID, APPOINTMENT_ID);
      assert.equal(payment?.status, "voided");
      assert.equal(payment?.is_current, undefined);
      assert.equal(db.state.appointment_payments.length, 1);
      assert.equal(db.state.appointment_payments[0].status, "voided");
      assert.equal(db.state.appointment_payments[0].is_current, false);
    } finally {
      db.restore();
    }
  });

  it("returns an appointment payment summary", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "venmo",
      display_name: "Venmo",
      payment_url: "https://venmo.com/example",
      is_active: true,
      is_default: false,
      sort_order: 0
    });
    state.appointment_payments.push({
      id: "99999999-9999-4999-8999-999999999999",
      user_id: USER_ID,
      appointment_id: APPOINTMENT_ID,
      payment_method_id: PAYMENT_METHOD_ID,
      status: "marked_paid",
      amount: 100,
      tip_amount: 10,
      total_recorded: 110,
      external_provider: "venmo",
      external_provider_label: "Venmo",
      external_reference: "note",
      notes: "Recorded after appointment",
      is_current: true,
      marked_paid_at: "2026-06-22T10:00:00.000Z",
      created_at: "2026-06-22T10:00:00.000Z",
      updated_at: "2026-06-22T10:00:00.000Z"
    });
    const db = installMockSupabase(state);

    try {
      const payment = await appointmentPaymentsService.get(USER_ID, APPOINTMENT_ID);
      assert.equal(payment?.total_recorded, 110);
      assert.deepEqual(payment?.payment_method, {
        id: PAYMENT_METHOD_ID,
        provider: "venmo",
        display_name: "Venmo"
      });
    } finally {
      db.restore();
    }
  });

  it("QR upload intent rejects unsupported MIME types", () => {
    assert.throws(
      () => qrUploadIntentSchema.parse({
        filename: "qr.gif",
        content_type: "image/gif",
        size_bytes: 1024
      }),
      /Invalid enum value/
    );
  });

  it("QR upload intent rejects files over 5MB", () => {
    assert.throws(
      () => qrUploadIntentSchema.parse({
        filename: "qr.png",
        content_type: "image/png",
        size_bytes: 5 * 1024 * 1024 + 1
      }),
      /less than or equal to 5242880/
    );
  });

  it("creates a server-generated QR upload intent", async () => {
    const storage = installStorageMock();

    try {
      const intent = await paymentMethodsService.createQrUploadIntent(USER_ID, {
        content_type: "image/png",
        size_bytes: 1024
      });

      assert.equal(storage.calls.bucket[0], "payment-method-qrs");
      assert.match(intent.storage_path, new RegExp(`^payment-method-qrs/${USER_ID}/.+\\.png$`));
      assert.equal(intent.upload_url.includes(intent.storage_path), true);
      assert.equal(intent.expires_in, 7200);
    } finally {
      storage.restore();
    }
  });
});
