import type { Request, Response } from "express";
import { getAuthUserId, getCurrentUser } from "../lib/request";
import { availabilityService } from "../services/availabilityService";
import { bookingRulesService } from "../services/bookingRulesService";
import { renderAppointmentEmail } from "../services/appointmentEmailDeliveryService";
import { appointmentEmailTemplatesService } from "../services/appointmentEmailTemplatesService";
import { rebookNudgeSettingsService } from "../services/rebookNudgeSettingsService";
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

  async getAppointmentEmailTemplates(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const templates = await appointmentEmailTemplatesService.getForUser(userId);
    res.json({ data: templates });
  },

  async updateAppointmentEmailTemplate(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const template = await appointmentEmailTemplatesService.upsertForUser(
      userId,
      req.params.emailType as string,
      req.body
    );
    res.json({ data: template });
  },

  async resetAppointmentEmailTemplate(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const template = await appointmentEmailTemplatesService.resetForUser(userId, req.params.emailType as string);
    res.json({ data: template });
  },

  async previewAppointmentEmailTemplate(req: Request, res: Response) {
    appointmentEmailTemplatesService.validateTemplatePayload(req.body);
    const message = renderAppointmentEmail({
      id: "preview",
      email_type: req.params.emailType,
      recipient_email: "client@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Silk Press",
        appointment_start_time: "2099-05-12T16:00:00.000Z",
        appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
        duration_minutes: 60,
        business_timezone: "America/Denver",
        business_display_name: "Maya Johnson Hair",
        business_phone: "(720) 555-0100",
        business_email: "maya@example.com",
        management_token: "preview-token",
        email_template: {
          subject_template: req.body.subjectTemplate ?? null,
          custom_message_block: req.body.customMessageBlock ?? null
        }
      }
    });

    res.json({
      data: {
        subject: message.subject,
        text: message.text,
        html: message.html
      }
    });
  },

  async getRebookNudgeSettings(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await rebookNudgeSettingsService.getForUser(userId);
    res.json({ data: settings });
  },

  async updateRebookNudgeSettings(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const settings = await rebookNudgeSettingsService.upsertForUser(userId, req.body);
    res.json({ data: settings });
  },

  async previewRebookNudgeSettings(req: Request, res: Response) {
    rebookNudgeSettingsService.validateSettingsPayload(req.body);
    const message = renderAppointmentEmail({
      id: "preview",
      email_type: "rebooking_prompt",
      recipient_email: "client@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Silk Press",
        last_service_name: "Silk Press",
        last_appointment_time: "2099-02-12T16:00:00.000Z",
        last_appointment_display: "February 12, 2099",
        rebook_interval_days: 90,
        business_timezone: "America/Denver",
        business_display_name: "Maya Johnson Hair",
        business_phone: "(720) 555-0100",
        business_email: "maya@example.com",
        rebook_url: "https://example.com/book/maya-johnson",
        message_type: "rebooking_prompt",
        email_template: {
          subject_template: req.body.subjectTemplate ?? null,
          custom_message_block: req.body.customMessageBlock ?? null
        }
      }
    });

    res.json({
      data: {
        subject: message.subject,
        text: message.text,
        html: message.html
      }
    });
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
