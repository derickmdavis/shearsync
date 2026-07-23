import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Request, Response } from "express";
import { appContentController } from "../controllers/appContentController";
import { appContentBundleService, createAppContentEtag } from "../services/appContentBundleService";
import { supabaseAdmin } from "../lib/supabase";
import { installMockSupabase } from "./helpers/mockSupabase";

const revisionId = "10000000-0000-4000-8000-000000000001";
const checksum = "a".repeat(64);

const state = () => ({
  app_content_locale_state: [{ locale: "en-US", active_revision_id: revisionId, active_version: 3 }],
  app_content_revisions: [{
    id: revisionId,
    locale: "en-US",
    version: 3,
    checksum,
    published_at: "2026-07-22T15:00:00.000Z"
  }],
  app_content_revision_entries: [
    { revision_id: revisionId, definition_key: "insights.screen.subtitle", value: "Your business at a glance" },
    { revision_id: revisionId, definition_key: "insights.screen.title", value: "Insights" }
  ]
});

const createResponse = () => {
  const result = { statusCode: 200, headers: {} as Record<string, string>, body: null as unknown, ended: false };
  const response = {
    setHeader(name: string, value: string) { result.headers[name] = value; },
    status(code: number) { result.statusCode = code; return this; },
    end() { result.ended = true; return this; },
    json(value: unknown) { result.body = value; return this; }
  } as Partial<Response> as Response;
  return { result, response };
};

describe("published app-content bundles", () => {
  it("reads only the locale active revision and returns a stable ETag", async () => {
    const db = installMockSupabase(state());
    try {
      const bundle = await appContentBundleService.getPublishedBundle("en-US");
      assert.equal(bundle.version, 3);
      assert.deepEqual(bundle.content, {
        "insights.screen.subtitle": "Your business at a glance",
        "insights.screen.title": "Insights"
      });
      assert.equal(createAppContentEtag(bundle), `"app-content-en-US-v3-${checksum}"`);
    } finally {
      db.restore();
    }
  });

  it("returns 304 with cache headers when If-None-Match matches", async () => {
    const db = installMockSupabase(state());
    try {
      const etag = `"app-content-en-US-v3-${checksum}"`;
      const request = {
        query: { locale: "en-US" },
        header(name: string) { return name === "if-none-match" ? etag : undefined; }
      } as Partial<Request> as Request;
      const { result, response } = createResponse();

      await appContentController.getPublishedBundle(request, response);

      assert.equal(result.statusCode, 304);
      assert.equal(result.ended, true);
      assert.equal(result.headers.ETag, etag);
      assert.equal(result.headers["Cache-Control"], "private, max-age=300, stale-while-revalidate=86400");
      assert.equal(result.body, null);
    } finally {
      db.restore();
    }
  });

  it("falls back to the active en-US bundle for an unavailable requested locale", async () => {
    const db = installMockSupabase(state());
    try {
      const bundle = await appContentBundleService.getPublishedBundle("es-MX");
      assert.equal(bundle.locale, "en-US");
      assert.equal(bundle.requestedLocale, "es-MX");
      assert.equal(bundle.fallbackApplied, true);
    } finally {
      db.restore();
    }
  });

  it("rejects an active revision with no entries instead of returning a partial bundle", async () => {
    const emptyState = state();
    emptyState.app_content_revision_entries = [];
    const db = installMockSupabase(emptyState);
    try {
      await assert.rejects(
        () => appContentBundleService.getPublishedBundle("en-US"),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 503
      );
    } finally {
      db.restore();
    }
  });

  it("propagates database failures instead of falling back to a partial response", async () => {
    const fromMock = mock.method(supabaseAdmin, "from", () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: null,
          error: { code: "57014", message: "statement timeout", details: null, hint: null }
        })
      };
      return query as never;
    });
    try {
      await assert.rejects(
        () => appContentBundleService.getPublishedBundle("en-US"),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 500
      );
    } finally {
      fromMock.mock.restore();
    }
  });
});
