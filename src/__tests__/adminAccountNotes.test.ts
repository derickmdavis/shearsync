import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { adminAccountNotesService } =
  require("../services/adminAccountNotesService") as typeof import("../services/adminAccountNotesService");

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("admin account notes", () => {
  it("creates notes with admin attribution and sanitized metadata", async () => {
    const db = installMockSupabase({ admin_account_notes: [] });

    try {
      const note = await adminAccountNotesService.createNote({
        accountUserId: USER_ID,
        createdByAdminEmail: "admin@example.com",
        note: "Customer asked about setup status.",
        metadata: {
          source: "support",
          raw_email: "stylist@example.com",
          signed_url: "https://example.supabase.co/object/sign/file.png?token=secret"
        }
      });

      assert.equal(note.account_user_id, USER_ID);
      assert.equal(note.created_by_admin_email, "admin@example.com");
      assert.deepEqual(note.metadata, {
        source: "support",
        raw_email: "[redacted]",
        signed_url: "[redacted]"
      });
    } finally {
      db.restore();
    }
  });

  it("lists notes newest first", async () => {
    const db = installMockSupabase({
      admin_account_notes: [
        {
          id: "old",
          account_user_id: USER_ID,
          note: "Old",
          created_at: "2026-06-23T10:00:00.000Z"
        },
        {
          id: "new",
          account_user_id: USER_ID,
          note: "New",
          created_at: "2026-06-24T10:00:00.000Z"
        }
      ]
    });

    try {
      const notes = await adminAccountNotesService.listNotes(USER_ID);

      assert.deepEqual(notes.map((note) => note.id), ["new", "old"]);
    } finally {
      db.restore();
    }
  });

  it("rejects empty note content", async () => {
    const db = installMockSupabase({ admin_account_notes: [] });

    try {
      await assert.rejects(
        () => adminAccountNotesService.createNote({
          accountUserId: USER_ID,
          createdByAdminEmail: "admin@example.com",
          note: "   "
        }),
        /Admin note cannot be empty/
      );
    } finally {
      db.restore();
    }
  });
});
