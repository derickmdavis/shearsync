import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { accountAccessService } =
  require("../services/accountAccessService") as typeof import("../services/accountAccessService");

const EXPIRED_USER_ID = "11111111-1111-1111-1111-111111111111";

describe("account access expiry", () => {
  it("expires an elapsed account period during an access check", async () => {
    const supabase = installMockSupabase({
      users: [{
        id: EXPIRED_USER_ID,
        account_status: "active",
        activated_at: "2026-01-01T00:00:00.000Z",
        current_period_ends_at: "2026-01-02T00:00:00.000Z",
        deactivated_at: null
      }]
    });

    try {
      const access = await accountAccessService.getAccountAccess(EXPIRED_USER_ID);

      assert.equal(access.status, "inactive");
      assert.equal(access.isActive, false);
      assert.equal(supabase.state.users[0]?.account_status, "inactive");
      assert.equal(typeof supabase.state.users[0]?.deactivated_at, "string");
    } finally {
      supabase.restore();
    }
  });

  it("expires every elapsed active account without touching future, unlimited, or inactive accounts", async () => {
    const supabase = installMockSupabase({
      users: [
        { id: EXPIRED_USER_ID, account_status: "active", current_period_ends_at: "2026-01-01T00:00:00.000Z" },
        { id: "22222222-2222-2222-2222-222222222222", account_status: "active", current_period_ends_at: "2026-02-01T00:00:00.000Z" },
        { id: "33333333-3333-3333-3333-333333333333", account_status: "active", current_period_ends_at: null },
        { id: "44444444-4444-4444-4444-444444444444", account_status: "inactive", current_period_ends_at: "2026-01-01T00:00:00.000Z" }
      ]
    });

    try {
      const result = await accountAccessService.expireEndedAccounts(new Date("2026-01-15T00:00:00.000Z"));

      assert.deepEqual(result, { expired: 1, processedAt: "2026-01-15T00:00:00.000Z" });
      assert.deepEqual(
        supabase.state.users.map((user) => user.account_status),
        ["inactive", "active", "active", "inactive"]
      );
      assert.equal(supabase.state.users[0]?.deactivated_at, "2026-01-15T00:00:00.000Z");
      assert.equal(supabase.state.users[3]?.deactivated_at, undefined);
    } finally {
      supabase.restore();
    }
  });
});
