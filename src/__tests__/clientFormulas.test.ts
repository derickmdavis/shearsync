import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientFormulasService } from "../services/clientFormulasService";
import { installMockSupabase } from "./helpers/mockSupabase";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENT = "44444444-4444-4444-8444-444444444444";
const state = () => ({ users: [{ id: USER }, { id: OTHER }], clients: [{ id: CLIENT, user_id: USER, first_name: "A" }, { id: OTHER_CLIENT, user_id: OTHER, first_name: "B" }], appointments: [] as Record<string, unknown>[], services: [] as Record<string, unknown>[], client_formulas: [] as Record<string, unknown>[], client_formula_sections: [] as Record<string, unknown>[], client_formula_photos: [] as Record<string, unknown>[], client_formula_images: [] as Record<string, unknown>[], appointment_images: [] as Record<string, unknown>[] });
const input = (title = "Gloss") => ({ title, formula_date: "2026-07-24", service_name_snapshot: "Gloss", processing_notes: null, result_notes: null, sections: [{ type: "formula", custom_label: null, content: "7N + 10 vol", sort_order: 0 }] });

describe("client formulas service", () => {
  it("atomically creates, updates, duplicates, and soft-deletes formulas", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await clientFormulasService.create(USER, CLIENT, input());
      assert.equal(db.state.client_formulas.length, 1); assert.equal((created.sections as unknown[]).length, 1);
      const updated = await clientFormulasService.update(USER, CLIENT, String(created.id), { title: "Updated", sections: [{ type: "formula", custom_label: null, content: "8N", sort_order: 0 }] });
      assert.equal(updated.title, "Updated"); assert.equal(db.state.client_formula_sections[0]?.content, "8N");
      const copied = await clientFormulasService.duplicate(USER, CLIENT, String(created.id));
      assert.match(String(copied.title), /copy/); assert.equal(db.state.client_formulas.length, 2);
      await clientFormulasService.remove(USER, CLIENT, String(created.id));
      assert.ok(db.state.client_formulas.find((row) => row.id === created.id)?.deleted_at);
    } finally { db.restore(); }
  });

  it("returns stable list cards and marks only the first first-page card latest", async () => {
    const data = state();
    data.client_formulas.push(
      { id: "55555555-5555-4555-8555-555555555555", user_id: USER, client_id: CLIENT, title: "New", formula_date: "2026-07-24", service_name_snapshot: "Gloss", created_at: "2026-07-24T10:00:00.000Z", deleted_at: null },
      { id: "66666666-6666-4666-8666-666666666666", user_id: USER, client_id: CLIENT, title: "Old", formula_date: "2026-07-23", service_name_snapshot: "Cut", created_at: "2026-07-23T10:00:00.000Z", deleted_at: null }
    );
    data.client_formula_sections.push({ id: "1", formula_id: "55555555-5555-4555-8555-555555555555", content: "  Clean   preview  ", sort_order: 0 });
    const db = installMockSupabase(data);
    try { const page = await clientFormulasService.list(USER, CLIENT, { limit: 1 }); assert.equal(page.data[0]?.is_latest, true); assert.equal(page.data[0]?.preview, "Clean preview"); assert.ok(page.next_cursor); const next = await clientFormulasService.list(USER, CLIENT, { limit: 1, cursor: page.next_cursor! }); assert.equal("is_latest" in (next.data[0] ?? {}), false); } finally { db.restore(); }
  });

  it("rejects cross-tenant formula and photo access", async () => {
    const db = installMockSupabase(state());
    try {
      await assert.rejects(() => clientFormulasService.create(OTHER, CLIENT, input()), /Client not found|does not belong/);
      await assert.rejects(() => clientFormulasService.attachPhoto(USER, CLIENT, "55555555-5555-4555-8555-555555555555", { source: "appointment", image_id: "foreign" }), /current plan|Formula not found/);
    } finally { db.restore(); }
  });
});
