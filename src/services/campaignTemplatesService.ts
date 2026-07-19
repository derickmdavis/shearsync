import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

type Cursor = { sort_order: number; id: string };
const encodeCursor = (row: Row) => Buffer.from(JSON.stringify({
  sort_order: Number(row.sort_order), id: String(row.id)
} satisfies Cursor)).toString("base64url");
const decodeCursor = (value: string): Cursor => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (!Number.isInteger(parsed.sort_order) || typeof parsed.id !== "string") throw new Error("invalid");
    return parsed as Cursor;
  } catch {
    throw new ApiError(400, "Invalid campaign template cursor");
  }
};

const toApi = (row: Row) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? null,
  link_type: row.link_type,
  icon_key: row.icon_key ?? null,
  subject: row.subject,
  message: row.message,
  suggested_audience: { mode: "everyone" as const },
  sort_order: Number(row.sort_order),
  version: Number(row.version),
  active: row.active === true
});

export const campaignTemplatesService = {
  async list(options: { status: "active" | "inactive" | "all"; limit: number; cursor?: string }) {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    let query = supabaseAdmin.from("campaign_templates").select("*");
    if (options.status !== "all") query = query.eq("active", options.status === "active");
    if (cursor) {
      query = query.or(`sort_order.gt.${cursor.sort_order},and(sort_order.eq.${cursor.sort_order},id.gt.${cursor.id})`);
    }
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .limit(options.limit + 1);
    handleSupabaseError(error, "Unable to load campaign templates");
    const rows = (data ?? []) as Row[];
    const page = rows.slice(0, options.limit);
    return {
      data: page.map(toApi),
      next_cursor: rows.length > options.limit && page.length ? encodeCursor(page[page.length - 1] as Row) : null
    };
  }
};
