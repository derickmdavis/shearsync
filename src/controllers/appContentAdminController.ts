import type { Request, Response } from "express";
import { ApiError } from "../lib/errors";
import { getRequiredParam } from "../lib/request";
import { appContentDraftsService } from "../services/appContentDraftsService";
import { appContentPublicationService } from "../services/appContentPublicationService";

const getAdminActor = (req: Request) => {
  if (!req.admin?.email || !req.admin.userId) {
    throw new ApiError(403, "Admin access required");
  }

  return { email: req.admin.email, userId: req.admin.userId };
};

export const appContentAdminController = {
  async listDefinitions(req: Request, res: Response) {
    res.json({ data: await appContentDraftsService.listDefinitions(req.query as never) });
  },

  async createDefinition(req: Request, res: Response) {
    const actor = getAdminActor(req);
    const created = await appContentDraftsService.createDefinition({
      key: req.body.key,
      namespace: req.body.namespace,
      category: req.body.category,
      description: req.body.description,
      allowedPlaceholders: req.body.allowed_placeholders,
      maxLength: req.body.max_length,
      multilineAllowed: req.body.multiline_allowed,
      fallbackRequired: req.body.fallback_required,
      developerNotes: req.body.developer_notes,
      actorEmail: actor.email
    });
    res.status(201).json({ data: created });
  },

  async updateDefinition(req: Request, res: Response) {
    const actor = getAdminActor(req);
    const body = req.body as Record<string, unknown>;
    res.json({
      data: await appContentDraftsService.updateDefinition(getRequiredParam(req, "key"), {
        ...(body.category !== undefined ? { category: body.category as never } : {}),
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        ...(body.allowed_placeholders !== undefined ? { allowedPlaceholders: body.allowed_placeholders as string[] } : {}),
        ...(body.max_length !== undefined ? { maxLength: body.max_length as number } : {}),
        ...(body.multiline_allowed !== undefined ? { multilineAllowed: body.multiline_allowed as boolean } : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active as boolean } : {}),
        ...(body.fallback_required !== undefined ? { fallbackRequired: body.fallback_required as boolean } : {}),
        ...(body.developer_notes !== undefined ? { developerNotes: body.developer_notes as string | null } : {}),
        actorEmail: actor.email
      })
    });
  },

  async getDraft(req: Request, res: Response) {
    res.json({
      data: await appContentDraftsService.getDraft(getRequiredParam(req, "key"), (req.query as { locale: string }).locale)
    });
  },

  async listDrafts(req: Request, res: Response) {
    res.json({ data: await appContentDraftsService.listDrafts(req.query as never) });
  },

  async putDraft(req: Request, res: Response) {
    const actor = getAdminActor(req);
    res.json({
      data: await appContentDraftsService.putDraft(getRequiredParam(req, "key"), {
        locale: req.body.locale,
        value: req.body.value,
        expectedDraftVersion: req.body.expected_draft_version,
        actorEmail: actor.email,
        actorUserId: actor.userId
      })
    });
  },

  async validateDrafts(req: Request, res: Response) {
    res.json({ data: await appContentDraftsService.validateDrafts(req.body) });
  },

  async publish(req: Request, res: Response) {
    const actor = getAdminActor(req);
    res.json({
      data: await appContentPublicationService.publish({
        locale: req.body.locale,
        expectedActiveVersion: req.body.expected_active_version,
        actorUserId: actor.userId,
        actorEmail: actor.email
      })
    });
  },

  async rollback(req: Request, res: Response) {
    const actor = getAdminActor(req);
    res.json({
      data: await appContentPublicationService.rollback({
        locale: req.body.locale,
        revisionId: req.body.revision_id,
        expectedActiveVersion: req.body.expected_active_version,
        actorUserId: actor.userId,
        actorEmail: actor.email
      })
    });
  },

  async listRevisions(req: Request, res: Response) {
    res.json({ data: await appContentPublicationService.listRevisions(req.query as never) });
  },

  async getRevision(req: Request, res: Response) {
    res.json({ data: await appContentPublicationService.getRevision(getRequiredParam(req, "id")) });
  },

  async listAudit(req: Request, res: Response) {
    const query = req.query as unknown as { locale?: string; key?: string; revision_id?: string; limit: number; offset: number };
    res.json({
      data: await appContentPublicationService.listAudit({
        locale: query.locale,
        key: query.key,
        revisionId: query.revision_id,
        limit: query.limit,
        offset: query.offset
      })
    });
  }
};
