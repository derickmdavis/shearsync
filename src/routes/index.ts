import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { accountRouter } from "./accountRoutes";
import { activityRouter } from "./activityRoutes";
import { appointmentRouter } from "./appointmentRoutes";
import { authRouter } from "./authRoutes";
import { calendarRouter } from "./calendarRoutes";
import { clientActionsRouter } from "./clientActionsRoutes";
import { clientRouter } from "./clientRoutes";
import { dashboardRouter } from "./dashboardRoutes";
import { healthRouter } from "./healthRoutes";
import { photoRouter } from "./photoRoutes";
import { profileRouter } from "./profileRoutes";
import { publicRouter } from "./publicRoutes";
import { reminderRouter } from "./reminderRoutes";
import { serviceRouter } from "./serviceRoutes";
import { settingsRouter } from "./settingsRoutes";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/api/public", publicRouter);
apiRouter.use("/me", requireAuth);
apiRouter.use("/api", requireAuth);

apiRouter.use(authRouter);
apiRouter.use("/api/account", accountRouter);
apiRouter.use("/api/activity", activityRouter);
apiRouter.use("/api/client-actions", clientActionsRouter);
apiRouter.use("/api/clients", clientRouter);
apiRouter.use("/api/appointments", appointmentRouter);
apiRouter.use("/api/calendar", calendarRouter);
apiRouter.use("/api/photos", photoRouter);
apiRouter.use("/api/reminders", reminderRouter);
apiRouter.use("/api/dashboard", dashboardRouter);
apiRouter.use("/api/profile", profileRouter);
apiRouter.use("/api/services", serviceRouter);
apiRouter.use("/api/settings", settingsRouter);
