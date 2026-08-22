import { Router } from "express";
import { accountController } from "../controllers/accountController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { accountDeletionRateLimiter } from "../middleware/rateLimit";
import { requestAccountDeletionSchema } from "../validators/accountValidators";

export const accountRouter = Router();

accountRouter.get("/deletion-request", asyncHandler(accountController.getDeletionRequest));
accountRouter.post(
  "/deletion-request",
  accountDeletionRateLimiter,
  validate({ body: requestAccountDeletionSchema }),
  asyncHandler(accountController.requestDeletion)
);
accountRouter.delete(
  "/",
  accountDeletionRateLimiter,
  validate({ body: requestAccountDeletionSchema }),
  asyncHandler(accountController.requestDeletion)
);
accountRouter.get("/access", asyncHandler(accountController.getAccess));
