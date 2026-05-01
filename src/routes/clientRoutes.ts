import { Router } from "express";
import { appointmentsController } from "../controllers/appointmentsController";
import { clientsController } from "../controllers/clientsController";
import { photosController } from "../controllers/photosController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { createClientSchema, updateClientSchema } from "../validators/clientValidators";
import { uuidParamSchema } from "../validators/common";

export const clientRouter = Router();

clientRouter.get("/", asyncHandler(clientsController.list));
clientRouter.post("/", validate({ body: createClientSchema }), asyncHandler(clientsController.create));
clientRouter.get("/:id", validate({ params: uuidParamSchema }), asyncHandler(clientsController.getById));
clientRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateClientSchema }),
  asyncHandler(clientsController.update)
);
clientRouter.delete("/:id", validate({ params: uuidParamSchema }), asyncHandler(clientsController.remove));
clientRouter.get(
  "/:id/appointments",
  validate({ params: uuidParamSchema }),
  asyncHandler(appointmentsController.listByClient)
);
clientRouter.get("/:id/photos", validate({ params: uuidParamSchema }), asyncHandler(photosController.listByClient));

