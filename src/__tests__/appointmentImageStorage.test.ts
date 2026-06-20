import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { supabaseAdmin } = require("../lib/supabase") as typeof import("../lib/supabase");
const { ApiError } = require("../lib/errors") as typeof import("../lib/errors");
const {
  appointmentImageStorageService,
  APPOINTMENT_IMAGES_BUCKET,
  APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES
} = require("../services/appointmentImageStorageService") as typeof import("../services/appointmentImageStorageService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const APPOINTMENT_ID = "33333333-3333-4333-8333-333333333333";
const IMAGE_ID = "44444444-4444-4444-8444-444444444444";

type StorageMockOptions = {
  info?: Record<string, { data: Record<string, unknown> | null; error: unknown | null }>;
  signedUploadError?: unknown | null;
  signedReadError?: unknown | null;
  removeError?: unknown | null;
};

const installStorageMock = (options: StorageMockOptions = {}) => {
  const calls = {
    buckets: [] as string[],
    createSignedUploadUrl: [] as string[],
    createSignedUrl: [] as Array<{ path: string; expiresIn: number }>,
    info: [] as string[],
    remove: [] as string[][]
  };
  const fromMock = mock.method(supabaseAdmin.storage, "from", (bucket: string) => {
    calls.buckets.push(bucket);

    return {
      createSignedUploadUrl: async (path: string) => {
        calls.createSignedUploadUrl.push(path);

        if (options.signedUploadError) {
          return { data: null, error: options.signedUploadError };
        }

        return {
          data: {
            signedUrl: `https://example.supabase.co/upload/${path}`,
            token: `token:${path}`,
            path
          },
          error: null
        };
      },
      createSignedUrl: async (path: string, expiresIn: number) => {
        calls.createSignedUrl.push({ path, expiresIn });

        if (options.signedReadError) {
          return { data: null, error: options.signedReadError };
        }

        return {
          data: {
            signedUrl: `https://example.supabase.co/read/${path}?expiresIn=${expiresIn}`
          },
          error: null
        };
      },
      info: async (path: string) => {
        calls.info.push(path);
        return options.info?.[path] ?? {
          data: {
            contentType: "image/jpeg",
            size: 2048
          },
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
    };
  });

  return {
    calls,
    restore: () => fromMock.mock.restore()
  };
};

describe("appointment image storage helpers", () => {
  it("generates server-owned appointment image paths from ownership fields and MIME types", () => {
    assert.deepEqual(
      appointmentImageStorageService.generatePaths({
        userId: USER_ID,
        clientId: CLIENT_ID,
        appointmentId: APPOINTMENT_ID,
        imageId: IMAGE_ID,
        displayContentType: "image/jpeg",
        thumbnailContentType: "image/webp"
      }),
      {
        storagePath:
          `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}.jpg`,
        thumbnailPath:
          `users/${USER_ID}/clients/${CLIENT_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}_thumb.webp`
      }
    );

    assert.deepEqual(
      appointmentImageStorageService.generatePaths({
        userId: USER_ID,
        appointmentId: APPOINTMENT_ID,
        imageId: IMAGE_ID,
        displayContentType: "image/png"
      }),
      {
        storagePath: `users/${USER_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}.png`,
        thumbnailPath: `users/${USER_ID}/appointments/${APPOINTMENT_ID}/${IMAGE_ID}_thumb.png`
      }
    );

    assert.throws(
      () =>
        appointmentImageStorageService.generatePaths({
          userId: USER_ID,
          clientId: CLIENT_ID,
          appointmentId: APPOINTMENT_ID,
          imageId: IMAGE_ID,
          displayContentType: "image/gif"
        }),
      ApiError
    );
  });

  it("creates signed upload and read URLs from the private appointment images bucket", async () => {
    const storage = installStorageMock();
    const paths = appointmentImageStorageService.generatePaths({
      userId: USER_ID,
      clientId: CLIENT_ID,
      appointmentId: APPOINTMENT_ID,
      imageId: IMAGE_ID,
      displayContentType: "image/jpeg",
      thumbnailContentType: "image/jpeg"
    });

    try {
      const uploadUrls = await appointmentImageStorageService.createSignedUploadUrls(paths);
      const readUrl = await appointmentImageStorageService.createSignedReadUrl(paths.storagePath, 120);

      assert.equal(uploadUrls.display.path, paths.storagePath);
      assert.equal(uploadUrls.thumbnail.path, paths.thumbnailPath);
      assert.equal(readUrl, `https://example.supabase.co/read/${paths.storagePath}?expiresIn=120`);
      assert.deepEqual(storage.calls.buckets, [
        APPOINTMENT_IMAGES_BUCKET,
        APPOINTMENT_IMAGES_BUCKET
      ]);
      assert.deepEqual(storage.calls.createSignedUploadUrl, [paths.storagePath, paths.thumbnailPath]);
      assert.deepEqual(storage.calls.createSignedUrl, [{ path: paths.storagePath, expiresIn: 120 }]);
    } finally {
      storage.restore();
    }
  });

  it("verifies object existence, content type, and byte size using Storage object info", async () => {
    const storage = installStorageMock({
      info: {
        "display.jpg": {
          data: {
            metadata: {
              mimetype: "image/jpeg",
              size: 4096
            }
          },
          error: null
        },
        "missing.jpg": {
          data: null,
          error: {
            message: "Object not found",
            statusCode: "404"
          }
        }
      }
    });

    try {
      assert.deepEqual(
        await appointmentImageStorageService.verifyObject("display.jpg", {
          expectedContentType: "image/jpeg",
          expectedSizeBytes: 4096,
          maxSizeBytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES
        }),
        {
          exists: true,
          path: "display.jpg",
          contentType: "image/jpeg",
          sizeBytes: 4096
        }
      );

      assert.deepEqual(await appointmentImageStorageService.verifyObject("missing.jpg"), {
        exists: false,
        path: "missing.jpg",
        contentType: null,
        sizeBytes: null
      });
      assert.deepEqual(storage.calls.info, ["display.jpg", "missing.jpg"]);
    } finally {
      storage.restore();
    }
  });

  it("rejects verified objects when Storage metadata does not match expected metadata", async () => {
    const storage = installStorageMock({
      info: {
        "display.jpg": {
          data: {
            contentType: "image/png",
            size: 4096
          },
          error: null
        }
      }
    });

    try {
      await assert.rejects(
        () =>
          appointmentImageStorageService.verifyObject("display.jpg", {
            expectedContentType: "image/jpeg",
            expectedSizeBytes: 4096
          }),
        /content type does not match/
      );
    } finally {
      storage.restore();
    }
  });

  it("deletes display and thumbnail objects together and ignores empty cleanup input", async () => {
    const storage = installStorageMock();

    try {
      assert.deepEqual(await appointmentImageStorageService.deleteObjects({}), []);
      assert.deepEqual(
        await appointmentImageStorageService.deleteObjects({
          storagePath: "display.jpg",
          thumbnailPath: "thumb.jpg"
        }),
        ["display.jpg", "thumb.jpg"]
      );
      assert.deepEqual(storage.calls.remove, [["display.jpg", "thumb.jpg"]]);
    } finally {
      storage.restore();
    }
  });
});
