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
const {
  appointmentImagesService
} = require("../services/appointmentImagesService") as typeof import("../services/appointmentImagesService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const APPOINTMENT_ID = "44444444-4444-4444-8444-444444444444";
const IMAGE_ID = "55555555-5555-4555-8555-555555555555";
const DISPLAY_PATH =
  `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}.jpg`;
const THUMB_PATH =
  `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}_thumb.jpg`;

type StorageMockOptions = {
  info?: Record<string, { data: Record<string, unknown> | null; error: unknown | null }>;
};

const installStorageMock = (options: StorageMockOptions = {}) => {
  const calls = {
    createSignedUploadUrl: [] as string[],
    createSignedUrl: [] as string[],
    info: [] as string[],
    remove: [] as string[][]
  };
  const fromMock = mock.method(supabaseAdmin.storage, "from", () => ({
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
    createSignedUrl: async (path: string) => {
      calls.createSignedUrl.push(path);
      return {
        data: {
          signedUrl: `https://example.supabase.co/read/${path}?token=test`
        },
        error: null
      };
    },
    info: async (path: string) => {
      calls.info.push(path);
      return options.info?.[path] ?? {
        data: {
          contentType: "image/jpeg",
          size: path.endsWith("_thumb.jpg") ? 512 : 2048
        },
        error: null
      };
    },
    remove: async (paths: string[]) => {
      calls.remove.push(paths);
      return { data: [], error: null };
    }
  }));

  return {
    calls,
    restore: () => fromMock.mock.restore()
  };
};

const baseState = () => ({
  appointments: [
    {
      id: APPOINTMENT_ID,
      user_id: USER_ID,
      client_id: CLIENT_ID,
      appointment_date: "2026-06-16T18:00:00.000Z",
      service_name: "Cut",
      duration_minutes: 60,
      status: "scheduled"
    }
  ],
  appointment_images: []
});

describe("appointment images service", () => {
  it("creates a pending upload intent with server-owned paths and expires stale pending rows first", async () => {
    const supabase = installMockSupabase({
      ...baseState(),
      appointment_images: [
        {
          id: "stale-image",
          user_id: USER_ID,
          appointment_id: APPOINTMENT_ID,
          upload_status: "pending",
          upload_expires_at: "2026-06-16T17:59:00.000Z"
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const intent = await appointmentImagesService.createUploadIntent(
        USER_ID,
        APPOINTMENT_ID,
        {
          original_filename: "before.jpg",
          content_type: "image/jpeg",
          input_size_bytes: 2048,
          display_content_type: "image/jpeg",
          thumbnail_content_type: "image/webp"
        },
        new Date("2026-06-16T18:00:00.000Z")
      );

      assert.equal(supabase.state.appointment_images[0]?.upload_status, "expired");
      assert.equal(intent.upload_status, "pending");
      assert.equal(intent.bucket, "appointment-images");
      assert.match(String(intent.storage_path), new RegExp(`users/${USER_ID}/clients/${CLIENT_ID}/appointments/${APPOINTMENT_ID}/.*\\.jpg$`));
      assert.match(String(intent.thumbnail_path), /_thumb\.webp$/);
      assert.equal(intent.upload_expires_at, "2026-06-16T18:15:00.000Z");
      assert.equal((intent.signed_upload_urls as { display: { path: string } }).display.path, intent.storage_path);
      assert.equal(storage.calls.createSignedUploadUrl.length, 2);
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("rejects upload intents when the appointment does not belong to the user or the image limit is reached", async () => {
    const fullImageSet = Array.from({ length: 10 }, (_, index) => ({
      id: `ready-image-${index}`,
      user_id: USER_ID,
      appointment_id: APPOINTMENT_ID,
      upload_status: "ready"
    }));
    const supabase = installMockSupabase({
      ...baseState(),
      appointment_images: fullImageSet
    });
    const storage = installStorageMock();
    const payload = {
      content_type: "image/jpeg",
      input_size_bytes: 2048,
      display_content_type: "image/jpeg",
      thumbnail_content_type: "image/jpeg"
    };

    try {
      await assert.rejects(
        () => appointmentImagesService.createUploadIntent(OTHER_USER_ID, APPOINTMENT_ID, payload),
        /Appointment not found/
      );
      await assert.rejects(
        () => appointmentImagesService.createUploadIntent(USER_ID, APPOINTMENT_ID, payload),
        /Appointment image limit reached/
      );
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("finalizes a pending upload only after Storage objects verify", async () => {
    const supabase = installMockSupabase({
      ...baseState(),
      appointment_images: [
        {
          id: IMAGE_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: APPOINTMENT_ID,
          bucket: "appointment-images",
          storage_path: DISPLAY_PATH,
          thumbnail_path: THUMB_PATH,
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          image_role: "general",
          image_source: "stylist",
          upload_status: "pending",
          upload_expires_at: "2026-06-16T18:15:00.000Z",
          cache_version: 1,
          sort_order: 0
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const finalized = await appointmentImagesService.finalize(
        USER_ID,
        APPOINTMENT_ID,
        {
          image_id: IMAGE_ID,
          storage_path: DISPLAY_PATH,
          thumbnail_path: THUMB_PATH,
          original_filename: "before.jpg",
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          thumbnail_size_bytes: 512,
          width: 1200,
          height: 900,
          image_role: "before",
          tags: ["before"],
          caption: "Before color"
        },
        new Date("2026-06-16T18:05:00.000Z")
      );

      assert.deepEqual(storage.calls.info, [DISPLAY_PATH, THUMB_PATH]);
      assert.equal(finalized.upload_status, "ready");
      assert.equal(finalized.finalized_at, "2026-06-16T18:05:00.000Z");
      assert.equal(finalized.image_role, "before");
      assert.equal(finalized.thumbnail_url, `https://example.supabase.co/read/${THUMB_PATH}?token=test`);
      assert.equal(supabase.state.appointment_images[0]?.upload_status, "ready");
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("marks pending uploads failed and cleans Storage when finalize verification fails", async () => {
    const supabase = installMockSupabase({
      ...baseState(),
      appointment_images: [
        {
          id: IMAGE_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: APPOINTMENT_ID,
          bucket: "appointment-images",
          storage_path: DISPLAY_PATH,
          thumbnail_path: THUMB_PATH,
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "pending",
          upload_expires_at: "2026-06-16T18:15:00.000Z"
        }
      ]
    });
    const storage = installStorageMock({
      info: {
        [DISPLAY_PATH]: {
          data: {
            contentType: "image/png",
            size: 2048
          },
          error: null
        }
      }
    });

    try {
      await assert.rejects(
        () => appointmentImagesService.finalize(
          USER_ID,
          APPOINTMENT_ID,
          {
            image_id: IMAGE_ID,
            storage_path: DISPLAY_PATH,
            thumbnail_path: THUMB_PATH,
            content_type: "image/jpeg",
            file_size_bytes: 2048,
            thumbnail_size_bytes: 512,
            image_role: "general"
          },
          new Date("2026-06-16T18:05:00.000Z")
        ),
        /content type does not match/
      );

      assert.deepEqual(storage.calls.remove, [[DISPLAY_PATH, THUMB_PATH]]);
      assert.equal(supabase.state.appointment_images[0]?.upload_status, "failed");
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("lists thumbnails, returns display URLs, updates metadata, reorders, and deletes with cleanup", async () => {
    const supabase = installMockSupabase({
      ...baseState(),
      appointment_images: [
        {
          id: IMAGE_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: APPOINTMENT_ID,
          bucket: "appointment-images",
          storage_path: DISPLAY_PATH,
          thumbnail_path: THUMB_PATH,
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "ready",
          finalized_at: "2026-06-16T18:05:00.000Z",
          cache_version: 1,
          sort_order: 0,
          created_at: "2026-06-16T18:05:00.000Z"
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const listed = await appointmentImagesService.list(USER_ID, APPOINTMENT_ID);
      const displayUrl = await appointmentImagesService.getDisplayUrl(USER_ID, APPOINTMENT_ID, IMAGE_ID);
      const updated = await appointmentImagesService.update(USER_ID, APPOINTMENT_ID, IMAGE_ID, {
        caption: "Updated",
        image_role: "after"
      });
      const reordered = await appointmentImagesService.reorder(USER_ID, APPOINTMENT_ID, [IMAGE_ID]);
      await appointmentImagesService.remove(USER_ID, APPOINTMENT_ID, IMAGE_ID);

      assert.equal(listed[0]?.thumbnail_url, `https://example.supabase.co/read/${THUMB_PATH}?token=test`);
      assert.equal(displayUrl.display_url, `https://example.supabase.co/read/${DISPLAY_PATH}?token=test`);
      assert.equal(updated.caption, "Updated");
      assert.equal(updated.image_role, "after");
      assert.equal(reordered[0]?.id, IMAGE_ID);
      assert.deepEqual(storage.calls.remove, [[DISPLAY_PATH, THUMB_PATH]]);
      assert.equal(supabase.state.appointment_images.length, 0);
    } finally {
      storage.restore();
      supabase.restore();
    }
  });
});
