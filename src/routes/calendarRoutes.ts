import { Router } from "express";
import { calendarController } from "../controllers/calendarController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { getCalendarDaySchema } from "../validators/calendarValidators";

export const calendarRouter = Router();

calendarRouter.get("/", validate({ query: getCalendarDaySchema }), asyncHandler(calendarController.getDay));
