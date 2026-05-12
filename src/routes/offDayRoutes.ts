import { Router } from "express";
import { offDaysController } from "../controllers/offDaysController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { uuidParamSchema } from "../validators/common";
import {
  bulkCreateOffDaysSchema,
  createOffDaySchema,
  listOffDaysQuerySchema,
  updateOffDaySchema
} from "../validators/offDayValidators";

export const offDayRouter = Router();

offDayRouter.get("/", validate({ query: listOffDaysQuerySchema }), asyncHandler(offDaysController.list));
offDayRouter.post("/", validate({ body: createOffDaySchema }), asyncHandler(offDaysController.create));
offDayRouter.post("/bulk", validate({ body: bulkCreateOffDaysSchema }), asyncHandler(offDaysController.bulkCreate));
offDayRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateOffDaySchema }),
  asyncHandler(offDaysController.update)
);
offDayRouter.delete("/:id", validate({ params: uuidParamSchema }), asyncHandler(offDaysController.delete));
