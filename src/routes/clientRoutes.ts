import { Router } from "express";
import { appointmentImagesController } from "../controllers/appointmentImagesController";
import { appointmentsController } from "../controllers/appointmentsController";
import { clientsController } from "../controllers/clientsController";
import { photosController } from "../controllers/photosController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { clientVisualHistoryQuerySchema } from "../validators/appointmentImageValidators";
import { createClientSchema, listClientsQuerySchema, updateClientSchema } from "../validators/clientValidators";
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
  validate({ params: uuidParamSchema }),
  asyncHandler(clientsController.createReferralLink)
);
clientRouter.get(
  "/:id/referral-stats",
  validate({ params: uuidParamSchema }),
  asyncHandler(clientsController.getReferralStats)
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
  validate({ params: uuidParamSchema }),
  asyncHandler(appointmentsController.listByClient)
);
clientRouter.get(
  "/:id/visual-history",
  validate({ params: uuidParamSchema, query: clientVisualHistoryQuerySchema }),
  asyncHandler(appointmentImagesController.listClientVisualHistory)
);
clientRouter.get("/:id/photos", validate({ params: uuidParamSchema }), asyncHandler(photosController.listByClient));
