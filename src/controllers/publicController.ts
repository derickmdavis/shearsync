import type { Request, Response } from "express";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getRequiredParam } from "../lib/request";
import { createEarlyAccessRequestSchema } from "../validators/earlyAccessValidators";
import { availabilityService } from "../services/availabilityService";
import { earlyAccessService } from "../services/earlyAccessService";
import { publicBookingIntakeService } from "../services/publicBookingIntakeService";
import { publicAppointmentManagementService } from "../services/publicAppointmentManagementService";
import { publicAppointmentImagesService } from "../services/publicAppointmentImagesService";
import { publicBookingsService } from "../services/publicBookingsService";
import { referralLinksService, type ReferralSource } from "../services/referralLinksService";
import { servicesService } from "../services/servicesService";
import { stylistsService } from "../services/stylistsService";
import { waitlistService } from "../services/waitlistService";
import { recordProductTelemetry } from "../services/productTelemetry";
import { campaignAttributionService } from "../services/campaignAttributionService";
import { campaignDeliveryAnalyticsService } from "../services/campaignDeliveryAnalyticsService";

const setLiveInventoryHeaders = (res: Response) => {
  if (typeof res.set === "function") {
    res.set("Cache-Control", "no-store");
  }
};

const getElapsedMs = (startedAt: bigint): number =>
  Math.round((Number(process.hrtime.bigint() - startedAt) / 1_000_000) * 100) / 100;

const getEarlyAccessValidationMessage = (path: string | undefined): string => {
  if (path === "email") {
    return "Please enter a valid email address.";
  }

  if (path === "full_name") {
    return "Please enter your full name.";
  }

  return "Please check your waitlist details and try again.";
};

export const publicController = {
  async redirectToBookingPage(req: Request, res: Response) {
    const webAppUrl = env.WEB_APP_URL ?? env.CLIENT_APP_URL;

    if (!webAppUrl) {
      throw new ApiError(404, "Public booking web app URL is not configured");
    }

    const slug = getRequiredParam(req, "slug");
    const redirectUrl = new URL(`/book/${slug}`, webAppUrl);
    res.redirect(302, redirectUrl.toString());
  },

  async getStylist(req: Request, res: Response) {
    const slug = getRequiredParam(req, "slug");
    const [stylist, internalStylist] = await Promise.all([
      stylistsService.getPublicProfileBySlug(slug),
      stylistsService.getBySlug(slug)
    ]);
    await recordProductTelemetry({
      accountUserId: typeof internalStylist.user_id === "string" ? internalStylist.user_id : null,
      eventType: "booking_page_viewed",
      eventSource: "public_booking",
      stylistSlug: slug,
      metadata: {
        stylist_slug: slug,
        source: "public_booking"
      }
    });
    res.json({ data: stylist });
  },

  async resolveReferral(req: Request, res: Response) {
    const referral = await referralLinksService.resolvePublicCode(getRequiredParam(req, "referralCode"), new Date(), {
      source: typeof req.query.source === "string" ? req.query.source as ReferralSource : undefined
    });
    res.json({ data: referral });
  },

  async resolveCampaignLink(req: Request, res: Response) {
    const token = getRequiredParam(req, "token");
    const campaignLink = await campaignAttributionService.resolvePublicLink(token);
    await campaignDeliveryAnalyticsService.recordTrackedClick(
      token,
      req.header("user-agent") ?? null
    );
    res.redirect(302, campaignLink.redirect_url);
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
    const startedAt = process.hrtime.bigint();
    const slug = getRequiredParam(req, "slug");
    const serviceId = req.query.service_id as string;
    const date = req.query.date as string;

    try {
      const availability = await availabilityService.getBookableSlotsByStylistSlug(
        slug,
        serviceId,
        date,
        typeof req.query.booking_context_token === "string"
          ? req.query.booking_context_token
          : undefined
      );
      logger.info("public_availability_slots_generated", {
        requestId: req.requestId,
        publicStylistSlug: slug,
        serviceId,
        date,
        latencyMs: getElapsedMs(startedAt),
        initialSlotCount: availability.slots.length,
        moreSlotCount: availability.moreSlots.length,
        hasMore: availability.hasMore
      });
      res.json({ data: availability });
    } catch (error) {
      logger.warn("public_availability_slots_failed", {
        requestId: req.requestId,
        publicStylistSlug: slug,
        serviceId,
        date,
        latencyMs: getElapsedMs(startedAt),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  },

  async createBookingIntake(req: Request, res: Response) {
    const intake = await publicBookingIntakeService.lookupBookingIntake(req.body);
    res.json({ data: intake });
  },

  async createBooking(req: Request, res: Response) {
    const startedAt = process.hrtime.bigint();
    const stylistSlug = typeof req.body.stylist_slug === "string" ? req.body.stylist_slug : undefined;
    const serviceId = typeof req.body.service_id === "string" ? req.body.service_id : undefined;

    try {
      const confirmation = await publicBookingsService.create(req.body);
      logger.info("public_booking_created", {
        requestId: req.requestId,
        publicStylistSlug: stylistSlug,
        serviceId,
        appointmentId: confirmation.appointment_id,
        clientId: confirmation.client_id,
        status: confirmation.status,
        latencyMs: getElapsedMs(startedAt)
      });
      res.status(201).json({ data: confirmation });
    } catch (error) {
      logger.warn("public_booking_failed", {
        requestId: req.requestId,
        publicStylistSlug: stylistSlug,
        serviceId,
        latencyMs: getElapsedMs(startedAt),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  },

  async createReferencePhotoUploadIntent(req: Request, res: Response) {
    const intent = await publicAppointmentImagesService.createUploadIntent(req.body);
    res.status(201).json({ data: intent });
  },

  async finalizeReferencePhoto(req: Request, res: Response) {
    const image = await publicAppointmentImagesService.finalize(req.body);
    res.status(201).json({ data: image });
  },

  async createWaitlistEntry(req: Request, res: Response) {
    const entry = await waitlistService.createPublicWaitlistEntry(getRequiredParam(req, "slug"), req.body);
    res.status(201).json({ data: entry });
  },

  async createEarlyAccessRequest(req: Request, res: Response) {
    const parsed = createEarlyAccessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        success: false,
        message: getEarlyAccessValidationMessage(issue?.path[0]?.toString())
      });
      return;
    }

    const result = await earlyAccessService.create(parsed.data);
    res.status(201).json(result);
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
  },

  async getAppointmentActionLink(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.getAppointmentActionLink(
      getRequiredParam(req, "shortCode")
    );
    res.json(appointment);
  },

  async cancelAppointmentActionLink(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.cancelAppointmentActionLink(
      getRequiredParam(req, "shortCode")
    );
    res.json(appointment);
  },

  async rescheduleAppointmentActionLink(req: Request, res: Response) {
    const appointment = await publicAppointmentManagementService.rescheduleAppointmentActionLink(
      getRequiredParam(req, "shortCode"),
      req.body
    );
    res.json(appointment);
  }
};
