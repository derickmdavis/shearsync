import { Router } from "express";
import { appointmentImagesController } from "../controllers/appointmentImagesController";
import { appointmentsController } from "../controllers/appointmentsController";
import { clientsController } from "../controllers/clientsController";
import { photosController } from "../controllers/photosController";
import { clientFormulasController } from "../controllers/clientFormulasController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { clientVisualHistoryQuerySchema } from "../validators/appointmentImageValidators";
import { listClientAppointmentsQuerySchema } from "../validators/appointmentValidators";
import {
  createClientReferralLinkSchema,
  createClientSchema,
  listClientsQuerySchema,
  updateClientAvatarSchema,
  updateClientRebookingPreferenceSchema,
  updateClientSmsPreferencesSchema,
  optInClientSmsSchema,
  optOutClientSmsSchema,
  updateClientSchema
} from "../validators/clientValidators";
import { attachFormulaPhotoSchema, createClientFormulaSchema, finalizeFormulaImageSchema, formulaParamsSchema, formulaPhotoParamsSchema, formulaImageUploadIntentSchema, listClientFormulasQuerySchema, reorderFormulaPhotosSchema, updateClientFormulaSchema } from "../validators/clientFormulaValidators";
import { uuidParamSchema } from "../validators/common";

export const clientRouter = Router();

clientRouter.get("/", validate({ query: listClientsQuerySchema }), asyncHandler(clientsController.list));
clientRouter.post("/", validate({ body: createClientSchema }), asyncHandler(clientsController.create));
clientRouter.get(
  "/:id/referral-link",
  validate({ params: uuidParamSchema }),
  asyncHandler(clientsController.getReferralLink)
);
clientRouter.post(
  "/:id/referral-link",
  validate({ params: uuidParamSchema, body: createClientReferralLinkSchema }),
  asyncHandler(clientsController.createReferralLink)
);
clientRouter.get(
  "/:id/referral-stats",
  validate({ params: uuidParamSchema }),
  asyncHandler(clientsController.getReferralStats)
);
clientRouter.get("/:id/detail", validate({ params: uuidParamSchema }), asyncHandler(clientsController.getDetail));
clientRouter.get("/:id/formulas", validate({ params: uuidParamSchema, query: listClientFormulasQuerySchema }), asyncHandler(clientFormulasController.list));
clientRouter.post("/:id/formulas", validate({ params: uuidParamSchema, body: createClientFormulaSchema }), asyncHandler(clientFormulasController.create));
clientRouter.get("/:id/formulas/:formulaId", validate({ params: formulaParamsSchema }), asyncHandler(clientFormulasController.get));
clientRouter.patch("/:id/formulas/:formulaId", validate({ params: formulaParamsSchema, body: updateClientFormulaSchema }), asyncHandler(clientFormulasController.update));
clientRouter.post("/:id/formulas/:formulaId/duplicate", validate({ params: formulaParamsSchema }), asyncHandler(clientFormulasController.duplicate));
clientRouter.delete("/:id/formulas/:formulaId", validate({ params: formulaParamsSchema }), asyncHandler(clientFormulasController.remove));
clientRouter.post("/:id/formulas/:formulaId/photos/upload-intent", validate({ params: formulaParamsSchema, body: formulaImageUploadIntentSchema }), asyncHandler(clientFormulasController.uploadIntent));
clientRouter.post("/:id/formulas/:formulaId/photos", validate({ params: formulaParamsSchema, body: finalizeFormulaImageSchema }), asyncHandler(clientFormulasController.finalize));
clientRouter.post("/:id/formulas/:formulaId/photos/attach", validate({ params: formulaParamsSchema, body: attachFormulaPhotoSchema }), asyncHandler(clientFormulasController.attachPhoto));
clientRouter.post("/:id/formulas/:formulaId/photos/reorder", validate({ params: formulaParamsSchema, body: reorderFormulaPhotosSchema }), asyncHandler(clientFormulasController.reorderPhotos));
clientRouter.delete("/:id/formulas/:formulaId/photos/:photoId", validate({ params: formulaPhotoParamsSchema }), asyncHandler(clientFormulasController.removePhoto));
clientRouter.patch(
  "/:id/rebooking-preference",
  validate({ params: uuidParamSchema, body: updateClientRebookingPreferenceSchema }),
  asyncHandler(clientsController.updateRebookingPreference)
);
clientRouter.get("/:id/sms-preferences", validate({ params: uuidParamSchema }), asyncHandler(clientsController.getSmsPreferences));
clientRouter.patch(
  "/:id/sms-preferences",
  validate({ params: uuidParamSchema, body: updateClientSmsPreferencesSchema }),
  asyncHandler(clientsController.updateSmsPreferences)
);
clientRouter.post(
  "/:id/sms-preferences/opt-in",
  validate({ params: uuidParamSchema, body: optInClientSmsSchema }),
  asyncHandler(clientsController.optInSms)
);
clientRouter.post(
  "/:id/sms-preferences/opt-out",
  validate({ params: uuidParamSchema, body: optOutClientSmsSchema }),
  asyncHandler(clientsController.optOutSms)
);
clientRouter.patch(
  "/:id/avatar",
  validate({ params: uuidParamSchema, body: updateClientAvatarSchema }),
  asyncHandler(clientsController.updateAvatar)
);
clientRouter.get("/:id", validate({ params: uuidParamSchema }), asyncHandler(clientsController.getById));
clientRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateClientSchema }),
  asyncHandler(clientsController.update)
);
clientRouter.post(
  "/:id/reactivate",
  validate({ params: uuidParamSchema }),
  asyncHandler(clientsController.reactivate)
);
clientRouter.delete("/:id", validate({ params: uuidParamSchema }), asyncHandler(clientsController.remove));
clientRouter.get(
  "/:id/appointments",
  validate({ params: uuidParamSchema, query: listClientAppointmentsQuerySchema }),
  asyncHandler(appointmentsController.listByClient)
);
clientRouter.get(
  "/:id/visual-history",
  validate({ params: uuidParamSchema, query: clientVisualHistoryQuerySchema }),
  asyncHandler(appointmentImagesController.listClientVisualHistory)
);
clientRouter.get("/:id/photos", validate({ params: uuidParamSchema }), asyncHandler(photosController.listByClient));
