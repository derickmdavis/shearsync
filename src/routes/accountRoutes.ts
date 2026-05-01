import { Router } from "express";
import { accountController } from "../controllers/accountController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { updateAccountPlanSchema } from "../validators/accountValidators";

export const accountRouter = Router();

accountRouter.get("/plan", asyncHandler(accountController.getPlan));
accountRouter.patch(
  "/plan",
  validate({ body: updateAccountPlanSchema }),
  asyncHandler(accountController.updatePlan)
);
