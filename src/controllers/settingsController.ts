import type { Request, Response } from "express";
import { getAuthUserId, getCurrentUser } from "../lib/request";
import { availabilityService } from "../services/availabilityService";
import { bookingRulesService } from "../services/bookingRulesService";
import { stylistsService } from "../services/stylistsService";
import { usersService } from "../services/usersService";

export const settingsController = {
  async getProfile(req: Request, res: Response) {
    const profile = await getCurrentUser(req);
    res.json({ data: profile });
  },

  async updateProfile(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const profile = await usersService.updateProfile(userId, req.body);
    res.json({ data: profile });
  },

  async getBooking(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await stylistsService.ensureByUserId(userId);
    res.json({ data: settings });
  },

  async getAvailability(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await availabilityService.getWeeklyForUser(userId);
    res.json({ data: settings });
  },

  async updateBooking(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await stylistsService.upsertForUser(userId, req.body);
    res.json({ data: settings });
  },

  async replaceAvailability(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await availabilityService.replaceWeeklyForUser(userId, req.body.days);
    res.json({ data: settings });
  },

  async getBookingRules(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await bookingRulesService.getByUserId(userId);
    res.json({ data: settings });
  },

  async updateBookingRules(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await bookingRulesService.updateForUser(userId, req.body);
    res.json({ data: settings });
  }
};
