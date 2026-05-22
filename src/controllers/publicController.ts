import type { Request, Response } from "express";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { getRequiredParam } from "../lib/request";
import { availabilityService } from "../services/availabilityService";
import { publicBookingIntakeService } from "../services/publicBookingIntakeService";
import { publicAppointmentManagementService } from "../services/publicAppointmentManagementService";
import { publicBookingsService } from "../services/publicBookingsService";
import { servicesService } from "../services/servicesService";
import { stylistsService } from "../services/stylistsService";
import { waitlistService } from "../services/waitlistService";

const setLiveInventoryHeaders = (res: Response) => {
  if (typeof res.set === "function") {
    res.set("Cache-Control", "no-store");
  }
};

export const publicController = {
  async redirectToBookingPage(req: Request, res: Response) {
    const webAppUrl = env.WEB_APP_URL ?? env.CLIENT_APP_URL;

    if (!webAppUrl) {
      throw new ApiError(404, "Public booking web app URL is not configured");
    }

    const slug = getRequiredParam(req, "slug");
    const redirectUrl = new URL(`/booking/${slug}`, webAppUrl);
    res.redirect(302, redirectUrl.toString());
  },

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
    setLiveInventoryHeaders(res);
    const availability = await availabilityService.listActiveByStylistSlug(getRequiredParam(req, "slug"), {
      bookingContextToken: typeof req.query.booking_context_token === "string"
        ? req.query.booking_context_token
        : undefined
    });
    res.json({ data: availability });
  },

  async getAvailabilitySlots(req: Request, res: Response) {
    setLiveInventoryHeaders(res);
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
  },

  async createWaitlistEntry(req: Request, res: Response) {
    const entry = await waitlistService.createPublicWaitlistEntry(getRequiredParam(req, "slug"), req.body);
    res.status(201).json({ data: entry });
  },

  async getManagedAppointment(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.getManagedAppointment(getRequiredParam(req, "token"));
    res.json({ data: appointment });
  },

  async cancelManagedAppointment(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.cancelManagedAppointment(getRequiredParam(req, "token"));
    res.json({ data: appointment });
  },

  async rescheduleManagedAppointment(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.rescheduleManagedAppointment(
      getRequiredParam(req, "token"),
      req.body
    );
    res.json({ data: appointment });
  }
};
