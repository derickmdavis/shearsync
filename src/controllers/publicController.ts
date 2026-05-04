import type { Request, Response } from "express";
import { getRequiredParam } from "../lib/request";
import { availabilityService } from "../services/availabilityService";
import { publicBookingIntakeService } from "../services/publicBookingIntakeService";
import { publicBookingsService } from "../services/publicBookingsService";
import { servicesService } from "../services/servicesService";
import { stylistsService } from "../services/stylistsService";

export const publicController = {
  async getStylist(req: Request, res: Response) {
    const stylist = await stylistsService.getPublicProfileBySlug(getRequiredParam(req, "slug"));
    res.json({ data: stylist });
  },

  async getServices(req: Request, res: Response) {
    const services = await servicesService.listActiveByStylistSlug(getRequiredParam(req, "slug"), {
      bookingContextToken: typeof req.query.booking_context_token === "string"
        ? req.query.booking_context_token
        : undefined
    });
    res.json({ data: services });
  },

  async getAvailability(req: Request, res: Response) {
    const availability = await availabilityService.listActiveByStylistSlug(getRequiredParam(req, "slug"), {
      bookingContextToken: typeof req.query.booking_context_token === "string"
        ? req.query.booking_context_token
        : undefined
    });
    res.json({ data: availability });
  },

  async getAvailabilitySlots(req: Request, res: Response) {
    const availability = await availabilityService.getBookableSlotsByStylistSlug(
      getRequiredParam(req, "slug"),
      req.query.service_id as string,
      req.query.date as string,
      typeof req.query.booking_context_token === "string"
        ? req.query.booking_context_token
        : undefined
    );
    res.json({ data: availability });
  },

  async createBookingIntake(req: Request, res: Response) {
    const intake = await publicBookingIntakeService.lookupBookingIntake(req.body);
    res.json({ data: intake });
  },

  async createBooking(req: Request, res: Response) {
    const confirmation = await publicBookingsService.create(req.body);
    res.status(201).json({ data: confirmation });
  }
};
