import { Router } from "express";
import { servicesController } from "../controllers/servicesController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { createServiceSchema, reorderServicesSchema, updateServiceSchema } from "../validators/serviceValidators";
import { uuidParamSchema } from "../validators/common";

export const serviceRouter = Router();

serviceRouter.get("/", asyncHandler(servicesController.list));
serviceRouter.post("/", validate({ body: createServiceSchema }), asyncHandler(servicesController.create));
serviceRouter.patch("/reorder", validate({ body: reorderServicesSchema }), asyncHandler(servicesController.reorder));
serviceRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateServiceSchema }),
  asyncHandler(servicesController.update)
);
serviceRouter.delete("/:id", validate({ params: uuidParamSchema }), asyncHandler(servicesController.delete));
