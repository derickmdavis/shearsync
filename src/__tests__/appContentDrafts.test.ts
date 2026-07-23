import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAppContentValue } from "../lib/appContent";
import { appContentDraftsService } from "../services/appContentDraftsService";
import { putAppContentDraftSchema } from "../validators/appContentValidators";
import { installMockSupabase } from "./helpers/mockSupabase";

const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";
const definition = {
  key: "insights.screen.subtitle",
  namespace: "insights",
  category: "screen",
  description: "Supporting text for the Insights screen.",
  allowed_placeholders: ["firstName"],
  max_length: 100,
  multiline_allowed: false,
  is_active: true,
  fallback_required: true,
  developer_notes: null
};

const state = () => ({
  app_content_definitions: [definition],
  app_content_drafts: []
});

describe("app-content value validation", () => {
  it("normalizes line endings and accepts allowed placeholders", () => {
    const result = validateAppContentValue("Welcome back, {{firstName}}", {
      allowedPlaceholders: ["firstName"], maxLength: 100, multilineAllowed: false
    });
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.placeholders, ["firstName"]);
  });

  it("rejects markup, unsupported placeholders, and line breaks for a single-line key", () => {
    const result = validateAppContentValue("<b>Hello</b>\n{{count}}", {
      allowedPlaceholders: ["firstName"], maxLength: 100, multilineAllowed: false
    });
    assert.deepEqual(result.issues.map((issue) => issue.code), ["newline", "markup", "placeholder"]);
  });

  it("normalizes en-us to en-US in draft requests", () => {
    const parsed = putAppContentDraftSchema.parse({
      locale: "en-us", value: "Your business at a glance", expected_draft_version: null
    });
    assert.equal(parsed.locale, "en-US");
  });
});

describe("app-content draft service", () => {
  it("creates a validated draft and increments the version only with the expected version", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await appContentDraftsService.putDraft(definition.key, {
        locale: "en-US",
        value: "Welcome back, {{firstName}}",
        expectedDraftVersion: null,
        actorEmail: "admin@example.com",
        actorUserId: ADMIN_USER_ID
      });
      assert.equal(created.draft.draft_version, 1);
      assert.equal(created.draft.value, "Welcome back, {{firstName}}");

      const updated = await appContentDraftsService.putDraft(definition.key, {
        locale: "en-US",
        value: "Your business at a glance",
        expectedDraftVersion: 1,
        actorEmail: "admin@example.com",
        actorUserId: ADMIN_USER_ID
      });
      assert.equal(updated.draft.draft_version, 2);

      await assert.rejects(
        () => appContentDraftsService.putDraft(definition.key, {
          locale: "en-US",
          value: "Stale write",
          expectedDraftVersion: 1,
          actorEmail: "admin@example.com",
          actorUserId: ADMIN_USER_ID
        }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 409
      );
    } finally {
      db.restore();
    }
  });

  it("does not persist unsafe draft content", async () => {
    const db = installMockSupabase(state());
    try {
      await assert.rejects(
        () => appContentDraftsService.putDraft(definition.key, {
          locale: "en-US",
          value: "<script>alert(1)</script>",
          expectedDraftVersion: null,
          actorEmail: "admin@example.com",
          actorUserId: ADMIN_USER_ID
        }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 400
      );
      assert.equal(db.state.app_content_drafts.length, 0);
    } finally {
      db.restore();
    }
  });
});
