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
const {
  publicAppointmentImagesService
} = require("../services/publicAppointmentImagesService") as typeof import("../services/publicAppointmentImagesService");
const {
  createPublicAppointmentImageUploadToken
} = require("../lib/publicAppointmentImageUpload") as typeof import("../lib/publicAppointmentImageUpload");

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

  it("prefetches bounded upcoming appointment thumbnails without display URLs", async () => {
    const appointmentTwoId = "66666666-6666-4666-8666-666666666666";
    const oldAppointmentId = "77777777-7777-4777-8777-777777777777";
    const imageTwoId = "88888888-8888-4888-8888-888888888888";
    const skippedImageId = "99999999-9999-4999-8999-999999999999";
    const imageTwoThumbPath =
      `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${appointmentTwoId}/${imageTwoId}_thumb.jpg`;
    const skippedThumbPath =
      `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${appointmentTwoId}/${skippedImageId}_thumb.jpg`;
    const supabase = installMockSupabase({
      ...baseState(),
      appointments: [
        {
          id: APPOINTMENT_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2026-06-16T18:00:00.000Z",
          service_name: "Cut",
          duration_minutes: 60,
          status: "scheduled"
        },
        {
          id: appointmentTwoId,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2026-06-17T18:00:00.000Z",
          service_name: "Color",
          duration_minutes: 90,
          status: "pending"
        },
        {
          id: oldAppointmentId,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2026-06-15T18:00:00.000Z",
          service_name: "Old cut",
          duration_minutes: 60,
          status: "scheduled"
        },
        {
          id: "foreign-appointment",
          user_id: OTHER_USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2026-06-16T19:00:00.000Z",
          service_name: "Foreign",
          duration_minutes: 60,
          status: "scheduled"
        }
      ],
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
          image_role: "general",
          image_source: "stylist",
          cache_version: 1,
          sort_order: 0,
          created_at: "2026-06-16T18:05:00.000Z"
        },
        {
          id: imageTwoId,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: appointmentTwoId,
          bucket: "appointment-images",
          storage_path: `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${appointmentTwoId}/${imageTwoId}.jpg`,
          thumbnail_path: imageTwoThumbPath,
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "ready",
          image_role: "general",
          image_source: "stylist",
          cache_version: 1,
          sort_order: 0,
          created_at: "2026-06-17T18:05:00.000Z"
        },
        {
          id: skippedImageId,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: appointmentTwoId,
          bucket: "appointment-images",
          storage_path: `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${appointmentTwoId}/${skippedImageId}.jpg`,
          thumbnail_path: skippedThumbPath,
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "ready",
          image_role: "after",
          image_source: "stylist",
          cache_version: 1,
          sort_order: 1,
          created_at: "2026-06-17T18:06:00.000Z"
        },
        {
          id: "pending-image",
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: APPOINTMENT_ID,
          bucket: "appointment-images",
          storage_path: "pending.jpg",
          thumbnail_path: "pending_thumb.jpg",
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "pending",
          cache_version: 1,
          sort_order: 1,
          created_at: "2026-06-16T18:06:00.000Z"
        },
        {
          id: "old-image",
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_id: oldAppointmentId,
          bucket: "appointment-images",
          storage_path: "old.jpg",
          thumbnail_path: "old_thumb.jpg",
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "ready",
          cache_version: 1,
          sort_order: 0,
          created_at: "2026-06-15T18:05:00.000Z"
        },
        {
          id: "foreign-image",
          user_id: OTHER_USER_ID,
          client_id: CLIENT_ID,
          appointment_id: APPOINTMENT_ID,
          bucket: "appointment-images",
          storage_path: "foreign.jpg",
          thumbnail_path: "foreign_thumb.jpg",
          content_type: "image/jpeg",
          file_size_bytes: 2048,
          upload_status: "ready",
          cache_version: 1,
          sort_order: 0,
          created_at: "2026-06-16T18:05:00.000Z"
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const result = await appointmentImagesService.prefetchThumbnails(USER_ID, {
        start_at: "2026-06-16T00:00:00.000Z",
        end_at: "2026-06-18T00:00:00.000Z",
        appointment_limit: 10,
        image_limit_per_appointment: 1,
        total_image_limit: 2
      });

      assert.deepEqual(result.appointments.map((appointment) => appointment.id), [APPOINTMENT_ID, appointmentTwoId]);
      assert.deepEqual(result.appointments.map((appointment) => appointment.images.map((image) => image.id)), [
        [IMAGE_ID],
        [imageTwoId]
      ]);
      assert.equal(result.appointments[0]?.images[0]?.thumbnail_url, `https://example.supabase.co/read/${THUMB_PATH}?token=test`);
      assert.equal(result.appointments[1]?.images[0]?.thumbnail_url, `https://example.supabase.co/read/${imageTwoThumbPath}?token=test`);
      assert.equal(result.meta.appointment_count, 2);
      assert.equal(result.meta.image_count, 2);
      assert.deepEqual(storage.calls.createSignedUrl, [THUMB_PATH, imageTwoThumbPath]);
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("allows one public client reference photo through upload intent and finalize", async () => {
    const tokenId = "66666666-6666-4666-8666-666666666666";
    const token = createPublicAppointmentImageUploadToken({
      appointmentId: APPOINTMENT_ID,
      clientId: CLIENT_ID,
      stylistId: USER_ID,
      appointmentStartTime: "2099-06-16T18:00:00.000Z",
      tokenId
    });
    const supabase = installMockSupabase({
      ...baseState(),
      appointments: [
        {
          id: APPOINTMENT_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2099-06-16T18:00:00.000Z",
          service_name: "Cut",
          duration_minutes: 60,
          status: "scheduled"
        }
      ],
      appointment_images: []
    });
    const storage = installStorageMock();

    try {
      const intent = await publicAppointmentImagesService.createUploadIntent({
        reference_photo_upload_token: token,
        original_filename: "inspo.jpg",
        content_type: "image/jpeg",
        input_size_bytes: 2048,
        display_content_type: "image/jpeg",
        thumbnail_content_type: "image/jpeg"
      });
      const imageId = intent.id as string;
      const displayPath = intent.storage_path as string;
      const thumbnailPath = intent.thumbnail_path as string;
      const finalized = await publicAppointmentImagesService.finalize({
        reference_photo_upload_token: token,
        image_id: imageId,
        storage_path: displayPath,
        thumbnail_path: thumbnailPath,
        original_filename: "inspo.jpg",
        content_type: "image/jpeg",
        file_size_bytes: 2048,
        thumbnail_size_bytes: 512,
        width: 1200,
        height: 900,
        caption: "Client inspiration"
      });

      assert.equal(intent.image_source, "client");
      assert.equal(intent.image_role, "reference");
      assert.equal(intent.public_upload_token_id, tokenId);
      assert.equal((intent.signed_upload_urls as { display: { path: string } }).display.path, displayPath);
      assert.equal(finalized.upload_status, "ready");
      assert.equal(finalized.image_source, "client");
      assert.equal(finalized.image_role, "reference");
      assert.equal(finalized.public_upload_token_id, tokenId);
      assert.equal(finalized.uploaded_by_user_id, null);
      assert.equal(finalized.caption, "Client inspiration");
      assert.deepEqual(storage.calls.info, [displayPath, thumbnailPath]);

      await assert.rejects(
        () => publicAppointmentImagesService.createUploadIntent({
          reference_photo_upload_token: token,
          content_type: "image/jpeg",
          input_size_bytes: 2048,
          display_content_type: "image/jpeg",
          thumbnail_content_type: "image/jpeg"
        }),
        /Appointment reference photo already exists/
      );
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("rejects public reference photo tokens for rescheduled appointments and duplicate pending references", async () => {
    const token = createPublicAppointmentImageUploadToken({
      appointmentId: APPOINTMENT_ID,
      clientId: CLIENT_ID,
      stylistId: USER_ID,
      appointmentStartTime: "2099-06-16T18:00:00.000Z"
    });
    const supabase = installMockSupabase({
      ...baseState(),
      appointments: [
        {
          id: APPOINTMENT_ID,
          user_id: USER_ID,
          client_id: CLIENT_ID,
          appointment_date: "2099-06-16T19:00:00.000Z",
          service_name: "Cut",
          duration_minutes: 60,
          status: "scheduled"
        }
      ],
      appointment_images: []
    });
    const storage = installStorageMock();

    try {
      await assert.rejects(
        () => publicAppointmentImagesService.createUploadIntent({
          reference_photo_upload_token: token,
          content_type: "image/jpeg",
          input_size_bytes: 2048,
          display_content_type: "image/jpeg",
          thumbnail_content_type: "image/jpeg"
        }),
        /Reference photo upload token is invalid or expired/
      );

      supabase.state.appointments[0].appointment_date = "2099-06-16T18:00:00.000Z";
      supabase.state.appointment_images.push({
        id: IMAGE_ID,
        user_id: USER_ID,
        client_id: CLIENT_ID,
        appointment_id: APPOINTMENT_ID,
        bucket: "appointment-images",
        storage_path: DISPLAY_PATH,
        thumbnail_path: THUMB_PATH,
        content_type: "image/jpeg",
        file_size_bytes: 2048,
        image_role: "reference",
        image_source: "client",
        upload_status: "pending",
        upload_expires_at: "2099-06-16T18:15:00.000Z",
        cache_version: 1
      });

      await assert.rejects(
        () => publicAppointmentImagesService.createUploadIntent({
          reference_photo_upload_token: token,
          content_type: "image/jpeg",
          input_size_bytes: 2048,
          display_content_type: "image/jpeg",
          thumbnail_content_type: "image/jpeg"
        }),
        /Appointment reference photo already exists/
      );
    } finally {
      storage.restore();
      supabase.restore();
    }
  });
});
