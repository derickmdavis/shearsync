import { Router } from "express";
import { adminController } from "../controllers/adminController";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/adminAuth";

export const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get("/status", (req, res) => {
  res.json({
    data: {
      ok: true,
      adminEmail: req.admin?.email ?? null
    }
  });
});
adminRouter.get("/system-health", asyncHandler(adminController.getSystemHealth));
adminRouter.get("/business-overview", asyncHandler(adminController.getBusinessOverview));
adminRouter.get("/accounts", asyncHandler(adminController.getAccounts));
adminRouter.get("/accounts/:userId/notes", asyncHandler(adminController.listAccountNotes));
adminRouter.post("/accounts/:userId/notes", asyncHandler(adminController.createAccountNote));
adminRouter.get("/accounts/:userId", asyncHandler(adminController.getAccountDetail));
