import { randomUUID } from "crypto";
import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { appointmentImageStorageService, APPOINTMENT_IMAGES_BUCKET } from "./appointmentImageStorageService";
import { clientsService } from "./clientsService";
import { handleSupabaseError, type Row, type RowList } from "./db";
import { entitlementsService } from "./entitlementsService";

const FIELDS = "id, user_id, client_id, appointment_id, service_id, title, formula_date, service_name_snapshot, processing_notes, result_notes, created_by, created_at, updated_at, deleted_at";
const IMAGE_LIMIT = 10;
const TTL_MINUTES = 15;
const THUMB_TTL = 300;
const FORMULA_RETENTION_DAYS = 30;
type Cursor = { formula_date: string; created_at: string; id: string };
const cursor = (row: Row) => Buffer.from(JSON.stringify({ formula_date: row.formula_date, created_at: row.created_at, id: row.id })).toString("base64url");
const decodeCursor = (value: string): Cursor => { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (typeof parsed.formula_date !== "string" || typeof parsed.created_at !== "string" || typeof parsed.id !== "string") throw new Error(); return parsed; } catch { throw new ApiError(400, "Invalid formula cursor"); } };
const imagePathType = (path: string) => path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
const preview = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 180) : null;
};
const titleFor = (input: Row, current?: Row): Row => {
  const serviceName = typeof input.service_name_snapshot === "string" && input.service_name_snapshot.trim()
    ? input.service_name_snapshot.trim()
    : typeof current?.service_name_snapshot === "string" ? current.service_name_snapshot : null;
  const provided = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
  if (provided) return { ...input, title: provided, title_source: "user" };
  if (serviceName) return { ...input, title: serviceName, title_source: "service_fallback" };
  const date = typeof input.formula_date === "string" ? input.formula_date : current?.formula_date;
  return { ...input, title: `Formula — ${date ?? ""}`, title_source: "date_fallback" };
};
const resolvedLabel = (section: Row): string => typeof section.display_label === "string" && section.display_label.trim() ? section.display_label : ({ root: "Root", lightener: "Lightener", toner: "Toner", gloss: "Gloss", color: "Color", mid_lengths: "Mid-lengths", ends: "Ends" } as Record<string, string>)[String(section.section_kind)] ?? section.custom_label as string ?? "Formula";

export const clientFormulasService = {
  async getOwned(userId: string, clientId: string, formulaId: string, includeDeleted = false): Promise<Row> {
    await clientsService.assertOwned(userId, clientId);
    let query = supabaseAdmin.from("client_formulas").select(FIELDS).eq("id", formulaId).eq("user_id", userId).eq("client_id", clientId);
    if (!includeDeleted) query = query.is("deleted_at", null);
    const { data, error } = await query.maybeSingle(); handleSupabaseError(error, "Unable to load formula"); return requireFound(data, "Formula not found");
  },

  async assertAssociations(userId: string, clientId: string, input: Row): Promise<void> {
    if (typeof input.appointment_id === "string") { const { data, error } = await supabaseAdmin.from("appointments").select("id").eq("id", input.appointment_id).eq("user_id", userId).eq("client_id", clientId).maybeSingle(); handleSupabaseError(error, "Unable to validate formula appointment"); requireFound(data, "Appointment not found for client"); }
    if (typeof input.service_id === "string") { const { data, error } = await supabaseAdmin.from("services").select("id").eq("id", input.service_id).eq("user_id", userId).maybeSingle(); handleSupabaseError(error, "Unable to validate formula service"); requireFound(data, "Service not found"); }
  },

  async list(userId: string, clientId: string, options: { limit?: number; cursor?: string; view?: "default" | "client-detail" }): Promise<{ data: RowList; next_cursor: string | null }> {
    await clientsService.assertOwned(userId, clientId); const limit = options.limit ?? 25; const after = options.cursor ? decodeCursor(options.cursor) : null;
    let query = supabaseAdmin.from("client_formulas").select(FIELDS).eq("user_id", userId).eq("client_id", clientId).is("deleted_at", null).order("formula_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (after) query = query.or(`formula_date.lt.${after.formula_date},and(formula_date.eq.${after.formula_date},created_at.lt.${after.created_at}),and(formula_date.eq.${after.formula_date},created_at.eq.${after.created_at},id.lt.${after.id})`);
    const { data, error } = await query; handleSupabaseError(error, "Unable to load formulas"); const rows = (data ?? []) as RowList; const page = rows.slice(0, limit);
    if (options.view === "client-detail") {
      if (page.length === 0) {
        return { data: [], next_cursor: null };
      }
      const ids = page.map((row) => String(row.id));
      const [{ data: sections, error: sectionsError }, { data: photos, error: photosError }, { data: appointments, error: appointmentsError }] = await Promise.all([
        supabaseAdmin.from("client_formula_sections").select("id, formula_id, section_kind, display_label, custom_label, content, sort_order").in("formula_id", ids).order("sort_order"),
        supabaseAdmin.from("client_formula_photos").select("id, formula_id, formula_image_id, appointment_image_id, photo_type, sort_order").in("formula_id", ids).order("sort_order"),
        supabaseAdmin.from("appointments").select("id, appointment_date, service_name, status").eq("user_id", userId).eq("client_id", clientId).in("id", page.map((row) => row.appointment_id).filter((id): id is string => typeof id === "string"))
      ]);
      handleSupabaseError(sectionsError, "Unable to load formula card sections"); handleSupabaseError(photosError, "Unable to load formula card photos"); handleSupabaseError(appointmentsError, "Unable to load formula card appointments");
      const sectionsByFormula = new Map<string, RowList>(); for (const section of (sections ?? []) as RowList) { const group = sectionsByFormula.get(String(section.formula_id)) ?? []; group.push(section); sectionsByFormula.set(String(section.formula_id), group); }
      const photosByFormula = new Map<string, RowList>(); for (const photo of (photos ?? []) as RowList) { const group = photosByFormula.get(String(photo.formula_id)) ?? []; group.push(photo); photosByFormula.set(String(photo.formula_id), group); }
      const appointmentById = new Map((appointments ?? []).map((appointment) => [String(appointment.id), appointment as Row]));
      return { data: await Promise.all(page.map(async (row, index) => { const cardSections = sectionsByFormula.get(String(row.id)) ?? []; const cardPhotos = photosByFormula.get(String(row.id)) ?? []; const card = cardSections.slice(0, 2).map((section) => ({ id: section.id, kind: section.section_kind ?? "custom", display_label: resolvedLabel(section), content: section.content, sort_order: section.sort_order })); const photoCards = await Promise.all(cardPhotos.slice(0, 2).map(async (photo) => { const table = photo.formula_image_id ? "client_formula_images" : "appointment_images"; const imageId = photo.formula_image_id ?? photo.appointment_image_id; const { data: image, error } = await supabaseAdmin.from(table).select("thumbnail_path").eq("id", imageId).eq("user_id", userId).eq("client_id", clientId).eq("upload_status", "ready").maybeSingle(); handleSupabaseError(error, "Unable to load formula card thumbnail"); return { id: photo.id, thumbnail_url: image?.thumbnail_path ? await appointmentImageStorageService.createSignedReadUrl(image.thumbnail_path, THUMB_TTL) : null, thumbnail_expires_at: image?.thumbnail_path ? new Date(Date.now() + THUMB_TTL * 1000).toISOString() : null, photo_type: photo.photo_type, sort_order: photo.sort_order }; })); return { id: row.id, title: row.title, title_source: row.title_source ?? "user", formula_date: row.formula_date, service_name_snapshot: row.service_name_snapshot ?? null, ...(!after && index === 0 ? { is_latest: true } : {}), sections: card, section_count: cardSections.length, additional_section_count: Math.max(0, cardSections.length - card.length), processing_notes: row.processing_notes ?? null, result_notes: row.result_notes ?? null, photos: photoCards, photo_count: cardPhotos.length, additional_photo_count: Math.max(0, cardPhotos.length - photoCards.length), appointment: typeof row.appointment_id === "string" ? appointmentById.get(row.appointment_id) ?? null : null, created_at: row.created_at, updated_at: row.updated_at }; })), next_cursor: rows.length > limit ? cursor(page[page.length - 1]) : null };
    }
    return {
      data: await Promise.all(page.map(async (row, index) => {
        const [{ data: firstSection, error: sectionError }, thumbnailUrl] = await Promise.all([
          supabaseAdmin.from("client_formula_sections").select("content").eq("formula_id", row.id).order("sort_order").limit(1).maybeSingle(),
          this.getThumbnailUrl(userId, clientId, row.id as string)
        ]);
        handleSupabaseError(sectionError, "Unable to load formula preview");
        return {
          id: row.id, title: row.title, formula_date: row.formula_date, service_name_snapshot: row.service_name_snapshot,
          preview: preview(firstSection?.content), thumbnail_url: thumbnailUrl,
          ...(!after && index === 0 ? { is_latest: true } : {})
        };
      })),
      next_cursor: rows.length > limit ? cursor(page[page.length - 1]) : null
    };
  },

  async create(userId: string, clientId: string, input: Row): Promise<Row> {
    await clientsService.assertOwned(userId, clientId); await this.assertAssociations(userId, clientId, input); const { sections, ...rawFormula } = input; const formula = titleFor(rawFormula);
    const { data, error } = await supabaseAdmin.rpc("create_client_formula", { p_user_id: userId, p_client_id: clientId, p_formula: formula, p_sections: sections });
    handleSupabaseError(error, "Unable to create formula"); const created = requireFound(data as Row | null, "Formula was not created");
    return this.detail(userId, clientId, created.id as string);
  },

  async update(userId: string, clientId: string, formulaId: string, input: Row): Promise<Row> {
    const current = await this.getOwned(userId, clientId, formulaId); await this.assertAssociations(userId, clientId, input); const { sections, ...rawUpdates } = input; const updates = (rawUpdates.title !== undefined || rawUpdates.service_name_snapshot !== undefined) ? titleFor(rawUpdates, current) : rawUpdates;
    const { error } = await supabaseAdmin.rpc("update_client_formula", { p_user_id: userId, p_client_id: clientId, p_formula_id: formulaId, p_updates: updates, p_sections: sections ?? null });
    handleSupabaseError(error, "Unable to update formula");
    return this.detail(userId, clientId, formulaId);
  },

  async duplicate(userId: string, clientId: string, formulaId: string): Promise<Row> {
    const source = await this.detail(userId, clientId, formulaId);
    return this.create(userId, clientId, {
      appointment_id: source.appointment_id, service_id: source.service_id, title: `${source.title} (copy)`,
      formula_date: new Date().toISOString().slice(0, 10), service_name_snapshot: source.service_name_snapshot,
      processing_notes: source.processing_notes, result_notes: source.result_notes, sections: source.sections as RowList
    });
  },
  async remove(userId: string, clientId: string, formulaId: string): Promise<void> { await this.getOwned(userId, clientId, formulaId); const deletedAt = new Date(); const { error } = await supabaseAdmin.from("client_formulas").update({ deleted_at: deletedAt.toISOString(), purge_after: new Date(deletedAt.getTime() + FORMULA_RETENTION_DAYS * 86400000).toISOString(), updated_at: deletedAt.toISOString() }).eq("id", formulaId).eq("user_id", userId); handleSupabaseError(error, "Unable to archive formula"); },

  async detail(userId: string, clientId: string, formulaId: string): Promise<Row> {
    const formula = await this.getOwned(userId, clientId, formulaId);
    const appointmentRequest = typeof formula.appointment_id === "string"
      ? supabaseAdmin.from("appointments").select("id, appointment_date, service_name, status").eq("id", formula.appointment_id).eq("user_id", userId).eq("client_id", clientId).maybeSingle()
      : Promise.resolve({ data: null, error: null });
    const [{ data: sections, error: sectionsError }, photos, appointmentResult] = await Promise.all([
      supabaseAdmin.from("client_formula_sections").select("id, formula_id, type, custom_label, section_kind, display_label, content, sort_order, created_at, updated_at").eq("formula_id", formulaId).order("sort_order"),
      this.listPhotos(userId, clientId, formulaId), appointmentRequest
    ]);
    handleSupabaseError(sectionsError, "Unable to load formula sections");
    handleSupabaseError(appointmentResult.error, "Unable to load formula appointment context");
    return {
      ...formula,
      sections: sections ?? [],
      photos,
      appointment: appointmentResult.data ?? null
    };
  },

  async createUploadIntent(userId: string, clientId: string, formulaId: string, payload: Row): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos"); await this.getOwned(userId, clientId, formulaId); const { count, error: countError } = await supabaseAdmin.from("client_formula_images").select("id", { count: "exact", head: true }).eq("formula_id", formulaId).in("upload_status", ["pending", "ready"]); handleSupabaseError(countError, "Unable to validate formula image limit"); if ((count ?? 0) >= IMAGE_LIMIT) throw new ApiError(409, "Formula image limit reached");
    const id = randomUUID(); const paths = appointmentImageStorageService.generateFormulaPaths({ userId, clientId, formulaId, imageId: id, displayContentType: payload.display_content_type as string, thumbnailContentType: payload.thumbnail_content_type as string }); const expires = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(); const urls = await appointmentImageStorageService.createSignedUploadUrls(paths);
    const { data, error } = await supabaseAdmin.from("client_formula_images").insert({ id, user_id: userId, client_id: clientId, formula_id: formulaId, bucket: APPOINTMENT_IMAGES_BUCKET, storage_path: paths.storagePath, thumbnail_path: paths.thumbnailPath, original_filename: payload.original_filename ?? null, content_type: payload.content_type, file_size_bytes: payload.input_size_bytes, upload_status: "pending", upload_expires_at: expires }).select("*").single(); handleSupabaseError(error, "Unable to create formula image upload intent"); return { ...requireFound(data), signed_upload_urls: urls };
  },

  async finalizeUpload(userId: string, clientId: string, formulaId: string, payload: Row): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos"); await this.getOwned(userId, clientId, formulaId); const { data, error } = await supabaseAdmin.from("client_formula_images").select("*").eq("id", payload.image_id).eq("user_id", userId).eq("client_id", clientId).eq("formula_id", formulaId).eq("upload_status", "pending").maybeSingle(); handleSupabaseError(error, "Unable to load formula image"); const image = requireFound(data, "Pending formula image not found"); if (String(image.upload_expires_at) <= new Date().toISOString()) throw new ApiError(410, "Formula image upload intent expired");
    const paths = { storagePath: payload.storage_path as string, thumbnailPath: payload.thumbnail_path as string }; if (paths.storagePath !== image.storage_path || paths.thumbnailPath !== image.thumbnail_path) throw new ApiError(400, "Formula image storage path does not match upload intent"); appointmentImageStorageService.assertFormulaPathMatches({ userId, clientId, formulaId, imageId: payload.image_id as string, displayContentType: payload.content_type as string, thumbnailContentType: imagePathType(paths.thumbnailPath), ...paths });
    const verified = await appointmentImageStorageService.verifyObjects(paths, { display: { expectedContentType: payload.content_type as string, expectedSizeBytes: payload.file_size_bytes as number, maxSizeBytes: 2097152 }, thumbnail: { expectedContentType: imagePathType(paths.thumbnailPath), expectedSizeBytes: payload.thumbnail_size_bytes as number | undefined, maxSizeBytes: 307200 } }); if (!verified.display.exists || !verified.thumbnail.exists) throw new ApiError(400, "Formula image upload is incomplete");
    const { data: ready, error: readyError } = await supabaseAdmin.from("client_formula_images").update({
      original_filename: payload.original_filename ?? image.original_filename, content_type: payload.content_type,
      file_size_bytes: payload.file_size_bytes, thumbnail_size_bytes: payload.thumbnail_size_bytes ?? null,
      width: payload.width, height: payload.height, thumbnail_width: payload.thumbnail_width, thumbnail_height: payload.thumbnail_height,
      image_role: payload.image_role, caption: payload.caption ?? null, upload_status: "ready", finalized_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", payload.image_id).select("*").single(); handleSupabaseError(readyError, "Unable to finalize formula image"); const position = await supabaseAdmin.from("client_formula_photos").select("sort_order").eq("formula_id", formulaId).order("sort_order", { ascending: false }).limit(1); handleSupabaseError(position.error, "Unable to position formula photo"); const attached = await supabaseAdmin.from("client_formula_photos").insert({ formula_id: formulaId, formula_image_id: payload.image_id, photo_type: payload.photo_type ?? null, sort_order: ((position.data?.[0] as Row | undefined)?.sort_order as number | undefined ?? -1) + 1 }).select("id").single(); handleSupabaseError(attached.error, "Unable to attach formula image"); return { ...requireFound(ready), photo_id: attached.data?.id };
  },

  async attachPhoto(userId: string, clientId: string, formulaId: string, input: Row): Promise<Row> { await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos"); await this.getOwned(userId, clientId, formulaId); const source = input.source as string; const table = source === "appointment" ? "appointment_images" : "client_formula_images"; let validation = supabaseAdmin.from(table).select("id").eq("id", input.image_id).eq("user_id", userId).eq("client_id", clientId).eq("upload_status", "ready"); if (source === "formula") validation = validation.eq("formula_id", formulaId); const { data, error } = await validation.maybeSingle(); handleSupabaseError(error, "Unable to validate formula photo"); requireFound(data, "Photo not found for client"); const { data: latest, error: latestError } = await supabaseAdmin.from("client_formula_photos").select("sort_order").eq("formula_id", formulaId).order("sort_order", { ascending: false }).limit(1); handleSupabaseError(latestError, "Unable to position formula photo"); const payload = source === "appointment" ? { formula_id: formulaId, appointment_image_id: input.image_id } : { formula_id: formulaId, formula_image_id: input.image_id }; const { data: row, error: insertError } = await supabaseAdmin.from("client_formula_photos").insert({ ...payload, photo_type: input.photo_type ?? null, sort_order: (((latest?.[0] as Row | undefined)?.sort_order as number | undefined) ?? -1) + 1 }).select("*").single(); handleSupabaseError(insertError, "Unable to attach formula photo"); return requireFound(row); },
  async removePhoto(userId: string, clientId: string, formulaId: string, photoId: string): Promise<void> { await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos"); await this.getOwned(userId, clientId, formulaId); const { error } = await supabaseAdmin.from("client_formula_photos").delete().eq("id", photoId).eq("formula_id", formulaId); handleSupabaseError(error, "Unable to remove formula photo"); },
  async reorderPhotos(userId: string, clientId: string, formulaId: string, ids: string[]): Promise<RowList> { await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos"); await this.getOwned(userId, clientId, formulaId); const { data, error } = await supabaseAdmin.from("client_formula_photos").select("id").eq("formula_id", formulaId).in("id", ids); handleSupabaseError(error, "Unable to load formula photos"); if ((data ?? []).length !== ids.length) throw new ApiError(400, "All reordered photos must belong to the formula"); for (const [sort_order, id] of ids.entries()) { const result = await supabaseAdmin.from("client_formula_photos").update({ sort_order, updated_at: new Date().toISOString() }).eq("id", id); handleSupabaseError(result.error, "Unable to reorder formula photos"); } return this.listPhotos(userId, clientId, formulaId); },
  async getThumbnailUrl(userId: string, clientId: string, formulaId: string): Promise<string | null> {
    const { data: photo, error } = await supabaseAdmin.from("client_formula_photos").select("formula_image_id, appointment_image_id").eq("formula_id", formulaId).order("sort_order").limit(1).maybeSingle(); handleSupabaseError(error, "Unable to load formula thumbnail"); if (!photo) return null;
    const table = photo.formula_image_id ? "client_formula_images" : "appointment_images";
    const imageId = photo.formula_image_id ?? photo.appointment_image_id;
    const { data: image, error: imageError } = await supabaseAdmin.from(table).select("thumbnail_path").eq("id", imageId).eq("user_id", userId).eq("client_id", clientId).eq("upload_status", "ready").maybeSingle(); handleSupabaseError(imageError, "Unable to load formula thumbnail image");
    return image?.thumbnail_path ? appointmentImageStorageService.createSignedReadUrl(image.thumbnail_path, THUMB_TTL) : null;
  },
  async listPhotos(userId: string, clientId: string, formulaId: string): Promise<RowList> { const { data, error } = await supabaseAdmin.from("client_formula_photos").select("*").eq("formula_id", formulaId).order("sort_order"); handleSupabaseError(error, "Unable to load formula photos"); return Promise.all((data ?? []).map(async (photo) => { const imageTable = photo.formula_image_id ? "client_formula_images" : "appointment_images"; const imageId = photo.formula_image_id ?? photo.appointment_image_id; const imageResult = await supabaseAdmin.from(imageTable).select("id, thumbnail_path, storage_path, content_type, width, height, upload_status").eq("id", imageId).eq("user_id", userId).eq("client_id", clientId).eq("upload_status", "ready").maybeSingle(); handleSupabaseError(imageResult.error, "Unable to load formula photo"); const image = requireFound(imageResult.data, "Formula photo not found"); return { id: photo.id, formula_id: formulaId, image_id: image.id, source: photo.formula_image_id ? "formula" : "appointment", photo_type: photo.photo_type, sort_order: photo.sort_order, created_at: photo.created_at, updated_at: photo.updated_at, thumbnail_url: image.thumbnail_path ? await appointmentImageStorageService.createSignedReadUrl(image.thumbnail_path, THUMB_TTL) : null, display_url: image.storage_path ? await appointmentImageStorageService.createSignedReadUrl(image.storage_path, THUMB_TTL) : null, content_type: image.content_type, width: image.width, height: image.height }; })); }
};
