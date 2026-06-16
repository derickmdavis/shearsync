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
  appointmentImageCleanupService
} = require("../services/appointmentImageCleanupService") as typeof import("../services/appointmentImageCleanupService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID = "22222222-2222-4222-8222-222222222222";

type StorageListItem = {
  name: string;
  id?: string | null;
  metadata?: Record<string, unknown>;
};

const installStorageMock = (options: {
  list?: Record<string, StorageListItem[]>;
  removeError?: unknown;
} = {}) => {
  const calls = {
    list: [] as Array<{ prefix: string; limit?: number; offset?: number }>,
    remove: [] as string[][]
  };
  const fromMock = mock.method(supabaseAdmin.storage, "from", () => ({
    list: async (prefix: string, listOptions: { limit?: number; offset?: number }) => {
      calls.list.push({
        prefix,
        limit: listOptions.limit,
        offset: listOptions.offset
      });

      return {
        data: options.list?.[prefix] ?? [],
        error: null
      };
    },
    remove: async (paths: string[]) => {
      calls.remove.push(paths);

      if (options.removeError) {
        return { data: null, error: options.removeError };
      }

      return { data: [], error: null };
    }
  }));

  return {
    calls,
    restore: () => fromMock.mock.restore()
  };
};

describe("appointment image cleanup", () => {
  it("deletes Storage objects for expired pending uploads before marking them expired", async () => {
    const supabase = installMockSupabase({
      appointment_images: [
        {
          id: "expired-pending",
          user_id: USER_ID,
          appointment_id: APPOINTMENT_ID,
          storage_path: "users/display.jpg",
          thumbnail_path: "users/display_thumb.jpg",
          upload_status: "pending",
          upload_expires_at: "2026-06-16T17:59:00.000Z"
        },
        {
          id: "still-valid",
          user_id: USER_ID,
          appointment_id: APPOINTMENT_ID,
          storage_path: "users/valid.jpg",
          thumbnail_path: "users/valid_thumb.jpg",
          upload_status: "pending",
          upload_expires_at: "2026-06-16T18:15:00.000Z"
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const result = await appointmentImageCleanupService.cleanupExpiredPendingUploads(
        new Date("2026-06-16T18:00:00.000Z"),
        { limit: 10 }
      );

      assert.deepEqual(result, {
        scanned: 1,
        expired: 1,
        storageDeleted: 2,
        storageDeleteFailed: 0,
        imageIds: ["expired-pending"],
        failedImageIds: []
      });
      assert.deepEqual(storage.calls.remove, [["users/display.jpg", "users/display_thumb.jpg"]]);
      assert.equal(supabase.state.appointment_images[0]?.upload_status, "expired");
      assert.equal(supabase.state.appointment_images[1]?.upload_status, "pending");
    } finally {
      storage.restore();
      supabase.restore();
    }
  });

  it("reports orphaned Storage objects by default and deletes them when dry run is disabled", async () => {
    const supabase = installMockSupabase({
      appointment_images: [
        {
          id: "known",
          storage_path: "users/known.jpg",
          thumbnail_path: "users/known_thumb.jpg",
          upload_status: "ready"
        }
      ]
    });
    const storage = installStorageMock({
      list: {
        users: [
          { name: "known.jpg", id: "known-object", metadata: {} },
          { name: "known_thumb.jpg", id: "known-thumb-object", metadata: {} },
          { name: "orphan.jpg", id: "orphan-object", metadata: {} }
        ]
      }
    });

    try {
      const dryRun = await appointmentImageCleanupService.cleanupOrphanedStorageObjects({
        prefix: "users",
        limit: 10
      });

      assert.deepEqual(dryRun, {
        scanned: 3,
        orphaned: 1,
        deleted: 0,
        failed: 0,
        dryRun: true,
        orphanPaths: ["users/orphan.jpg"],
        failedPaths: []
      });
      assert.deepEqual(storage.calls.remove, []);

      const deleted = await appointmentImageCleanupService.cleanupOrphanedStorageObjects({
        prefix: "users",
        limit: 10,
        dryRun: false
      });

      assert.equal(deleted.deleted, 1);
      assert.deepEqual(deleted.orphanPaths, ["users/orphan.jpg"]);
      assert.deepEqual(storage.calls.remove, [["users/orphan.jpg"]]);
    } finally {
      storage.restore();
      supabase.restore();
    }
  });
});
