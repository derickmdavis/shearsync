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
const { paymentMethodsService } =
  require("../services/paymentMethodsService") as typeof import("../services/paymentMethodsService");
const { paymentMethodQrStorageService } =
  require("../services/paymentMethodQrStorageService") as typeof import("../services/paymentMethodQrStorageService");
const { ApiError } = require("../lib/errors") as typeof import("../lib/errors");
const { qrUploadIntentSchema, createPaymentMethodSchema, updatePaymentMethodSchema } =
  require("../validators/paymentMethodsValidators") as typeof import("../validators/paymentMethodsValidators");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_METHOD_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_PAYMENT_METHOD_ID = "77777777-7777-4777-8777-777777777777";
const QR_IMAGE_ID = "88888888-8888-4888-8888-888888888888";

const baseState = () => ({
  users: [
    { id: USER_ID, email: "stylist@example.com" },
    { id: OTHER_USER_ID, email: "other@example.com" }
  ],
  clients: [
    { id: CLIENT_ID, user_id: USER_ID, first_name: "Ari", last_name: "Client" }
  ],
  appointments: [],
  payment_methods: [] as Record<string, unknown>[],
  product_events: [] as Record<string, unknown>[]
});

const installStorageMock = (options: { signedReadError?: { message: string; statusCode?: string } } = {}) => {
  const calls = {
    bucket: [] as string[],
    createSignedUploadUrl: [] as string[],
    createSignedUrl: [] as Array<{ path: string; expiresInSeconds: number }>
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
      },
      createSignedUrl: async (path: string, expiresInSeconds: number) => {
        calls.createSignedUrl.push({ path, expiresInSeconds });
        return {
          data: {
            signedUrl: `https://example.supabase.co/read/${path}?token=test`
          },
          error: options.signedReadError ?? null
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
      assert.equal(db.state.product_events.length, 1);
      assert.equal(db.state.product_events[0]?.event_type, "payment_shortcut_created");
      assert.deepEqual(db.state.product_events[0]?.metadata, {
        provider: "venmo",
        has_payment_url: true,
        has_qr_image_url: false,
        has_qr_image_path: false,
        is_default: false
      });
    } finally {
      db.restore();
    }
  });

  it("allows an authenticated user to create a payment shortcut with a QR image path", async () => {
    const db = installMockSupabase(baseState());
    const storage = installStorageMock();
    const storagePath = `${USER_ID}/${QR_IMAGE_ID}.png`;

    try {
      const method = await paymentMethodsService.create(USER_ID, {
        provider: "zelle",
        display_name: "Zelle QR",
        qr_image_path: storagePath
      });

      assert.equal(method.provider, "zelle");
      assert.equal(method.qr_image_path, storagePath);
      assert.equal(method.qr_image_url, null);
      assert.equal(method.qr_image_display_url, `https://example.supabase.co/read/${storagePath}?token=test`);
      assert.match(String(method.qr_image_display_url_expires_at), /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(db.state.payment_methods[0]?.qr_image_url, null);
      assert.deepEqual(db.state.product_events[0]?.metadata, {
        provider: "zelle",
        has_payment_url: false,
        has_qr_image_url: false,
        has_qr_image_path: true,
        is_default: false
      });
    } finally {
      storage.restore();
      db.restore();
    }
  });

  it("rejects QR image paths that were not generated for the authenticated user", async () => {
    const db = installMockSupabase(baseState());

    try {
      await assert.rejects(
        () => paymentMethodsService.create(USER_ID, {
          provider: "zelle",
          display_name: "Foreign QR",
          qr_image_path: `${OTHER_USER_ID}/${QR_IMAGE_ID}.png`
        }),
        /QR path must be generated by this account/
      );

      await assert.rejects(
        () => paymentMethodsService.create(USER_ID, {
          provider: "zelle",
          display_name: "Bucket-prefixed QR",
          qr_image_path: `payment-method-qrs/${USER_ID}/${QR_IMAGE_ID}.png`
        }),
        /QR path must be generated by this account/
      );
    } finally {
      db.restore();
    }
  });

  it("rejects invalid QR image paths on update", async () => {
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
      await assert.rejects(
        () => paymentMethodsService.update(USER_ID, PAYMENT_METHOD_ID, {
          qr_image_path: `${OTHER_USER_ID}/${QR_IMAGE_ID}.png`
        }),
        /QR path must be generated by this account/
      );
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

  it("returns fresh signed QR display URLs from list, update, and reorder responses", async () => {
    const storagePath = `${USER_ID}/${QR_IMAGE_ID}.png`;
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "zelle",
      display_name: "Zelle QR",
      qr_image_url: null,
      qr_image_path: storagePath,
      is_active: true,
      is_default: false,
      sort_order: 0,
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const db = installMockSupabase(state);
    const storage = installStorageMock();
    const expectedUrl = `https://example.supabase.co/read/${storagePath}?token=test`;

    try {
      const listed = await paymentMethodsService.list(USER_ID);
      const updated = await paymentMethodsService.update(USER_ID, PAYMENT_METHOD_ID, { instructions: "Scan to pay" });
      const reordered = await paymentMethodsService.reorder(USER_ID, [{ id: PAYMENT_METHOD_ID, sort_order: 1 }]);

      for (const method of [listed[0], updated, reordered[0]]) {
        assert.equal(method?.qr_image_url, null);
        assert.equal(method?.qr_image_display_url, expectedUrl);
        assert.match(String(method?.qr_image_display_url_expires_at), /^\d{4}-\d{2}-\d{2}T/);
      }
      assert.deepEqual(storage.calls.createSignedUrl, [
        { path: storagePath, expiresInSeconds: 300 },
        { path: storagePath, expiresInSeconds: 300 },
        { path: storagePath, expiresInSeconds: 300 }
      ]);
      assert.equal(db.state.payment_methods[0]?.qr_image_url, null);
    } finally {
      storage.restore();
      db.restore();
    }
  });

  it("preserves an externally hosted QR image URL without a signed display URL", async () => {
    const db = installMockSupabase(baseState());

    try {
      const method = await paymentMethodsService.create(USER_ID, {
        provider: "zelle",
        display_name: "Hosted Zelle QR",
        qr_image_url: "https://images.example.com/zelle-qr.png"
      });

      assert.equal(method.qr_image_url, "https://images.example.com/zelle-qr.png");
      assert.equal(method.qr_image_display_url, null);
      assert.equal(method.qr_image_display_url_expires_at, null);
    } finally {
      db.restore();
    }
  });

  it("does not sign a QR path that does not belong to the authenticated owner", async () => {
    const state = baseState();
    state.payment_methods.push({
      id: PAYMENT_METHOD_ID,
      user_id: USER_ID,
      provider: "zelle",
      display_name: "Invalid QR ownership",
      qr_image_path: `${OTHER_USER_ID}/${QR_IMAGE_ID}.png`,
      is_active: true,
      is_default: false,
      sort_order: 0
    });
    const db = installMockSupabase(state);
    const storage = installStorageMock();

    try {
      await assert.rejects(() => paymentMethodsService.list(USER_ID), /QR path must be generated by this account/);
      assert.deepEqual(storage.calls.createSignedUrl, []);
    } finally {
      storage.restore();
      db.restore();
    }
  });

  it("does not accept response-only signed QR display fields in payment method requests", () => {
    const created = createPaymentMethodSchema.parse({
      provider: "zelle",
      display_name: "Zelle QR",
      qr_image_url: "https://images.example.com/zelle-qr.png",
      qr_image_display_url: "https://example.supabase.co/read/private.png?token=secret",
      qr_image_display_url_expires_at: "2026-08-20T00:05:00.000Z"
    });
    const updated = updatePaymentMethodSchema.parse({
      qr_image_display_url: "https://example.supabase.co/read/private.png?token=secret",
      qr_image_display_url_expires_at: "2026-08-20T00:05:00.000Z"
    });

    assert.equal("qr_image_display_url" in created, false);
    assert.equal("qr_image_display_url_expires_at" in created, false);
    assert.equal("qr_image_display_url" in updated, false);
    assert.equal("qr_image_display_url_expires_at" in updated, false);
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
      assert.match(intent.storage_path, new RegExp(`^${USER_ID}/.+\\.png$`));
      assert.equal(intent.upload_url.includes(intent.storage_path), true);
      assert.equal(intent.expires_in, 7200);
    } finally {
      storage.restore();
    }
  });

  it("creates a five-minute signed read URL for a private QR image", async () => {
    const storage = installStorageMock();
    const storagePath = `${USER_ID}/${QR_IMAGE_ID}.png`;

    try {
      const signedUrl = await paymentMethodQrStorageService.createSignedReadUrl(storagePath);

      assert.equal(signedUrl, `https://example.supabase.co/read/${storagePath}?token=test`);
      assert.deepEqual(storage.calls.bucket, ["payment-method-qrs"]);
      assert.deepEqual(storage.calls.createSignedUrl, [{ path: storagePath, expiresInSeconds: 300 }]);
    } finally {
      storage.restore();
    }
  });

  it("returns a safe API error when private QR read signing fails", async () => {
    const storage = installStorageMock({
      signedReadError: { message: "Storage unavailable", statusCode: "503" }
    });
    const storagePath = `${USER_ID}/${QR_IMAGE_ID}.png`;

    try {
      await assert.rejects(
        () => paymentMethodQrStorageService.createSignedReadUrl(storagePath),
        (error: unknown) => error instanceof ApiError
          && error.statusCode === 500
          && error.message === "Unable to create payment shortcut QR read URL"
      );
    } finally {
      storage.restore();
    }
  });
});
