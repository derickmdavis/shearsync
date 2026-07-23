import { Router } from "express";
import { appContentAdminController } from "../controllers/appContentAdminController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  appContentDefinitionKeyParamSchema,
  appContentDraftQuerySchema,
  appContentRevisionIdParamSchema,
  createAppContentDefinitionSchema,
  listAppContentAuditQuerySchema,
  listAppContentDefinitionsQuerySchema,
  listAppContentDraftsQuerySchema,
  listAppContentRevisionsQuerySchema,
  publishAppContentSchema,
  putAppContentDraftSchema,
  rollbackAppContentSchema,
  updateAppContentDefinitionSchema,
  validateAppContentDraftsSchema
} from "../validators/appContentValidators";

export const appContentAdminRouter = Router();

appContentAdminRouter.get("/definitions", validate({ query: listAppContentDefinitionsQuerySchema }), asyncHandler(appContentAdminController.listDefinitions));
appContentAdminRouter.post("/definitions", validate({ body: createAppContentDefinitionSchema }), asyncHandler(appContentAdminController.createDefinition));
appContentAdminRouter.patch("/definitions/:key", validate({ params: appContentDefinitionKeyParamSchema, body: updateAppContentDefinitionSchema }), asyncHandler(appContentAdminController.updateDefinition));
appContentAdminRouter.get("/drafts", validate({ query: listAppContentDraftsQuerySchema }), asyncHandler(appContentAdminController.listDrafts));
appContentAdminRouter.get("/drafts/:key", validate({ params: appContentDefinitionKeyParamSchema, query: appContentDraftQuerySchema }), asyncHandler(appContentAdminController.getDraft));
appContentAdminRouter.put("/drafts/:key", validate({ params: appContentDefinitionKeyParamSchema, body: putAppContentDraftSchema }), asyncHandler(appContentAdminController.putDraft));
appContentAdminRouter.post("/validate", validate({ body: validateAppContentDraftsSchema }), asyncHandler(appContentAdminController.validateDrafts));
appContentAdminRouter.post("/publish", validate({ body: publishAppContentSchema }), asyncHandler(appContentAdminController.publish));
appContentAdminRouter.post("/rollback", validate({ body: rollbackAppContentSchema }), asyncHandler(appContentAdminController.rollback));
appContentAdminRouter.get("/revisions", validate({ query: listAppContentRevisionsQuerySchema }), asyncHandler(appContentAdminController.listRevisions));
appContentAdminRouter.get("/revisions/:id", validate({ params: appContentRevisionIdParamSchema }), asyncHandler(appContentAdminController.getRevision));
appContentAdminRouter.get("/audit", validate({ query: listAppContentAuditQuerySchema }), asyncHandler(appContentAdminController.listAudit));
