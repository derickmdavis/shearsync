import type { Request, Response } from "express";
import { appointmentEmailDeliveryService } from "../services/appointmentEmailDeliveryService";
import { appointmentImageCleanupService } from "../services/appointmentImageCleanupService";
import { appointmentRemindersService } from "../services/appointmentRemindersService";
import { birthdayRemindersService } from "../services/birthdayRemindersService";
import { clientPurgeService } from "../services/clientPurgeService";
import { rebookNudgesService } from "../services/rebookNudgesService";
import { thankYouEmailsService } from "../services/thankYouEmailsService";

export const internalController = {
  async processAppointmentEmails(req: Request, res: Response) {
    const query = req.query as {
      limit?: number;
      allow_noop?: boolean;
    };
    const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
      limit: typeof query.limit === "number" ? query.limit : undefined,
      allowNoopProvider: query.allow_noop === true
    });

    res.json({ data: result });
  },

  async queueAppointmentReminders(req: Request, res: Response) {
    const query = req.query as {
      limit?: number;
      user_limit?: number;
      appointment_limit?: number;
      window_minutes?: number;
    };
    const result = await appointmentRemindersService.queueDue(new Date(), {
      userLimit: query.user_limit,
      appointmentLimit: query.appointment_limit ?? query.limit,
      windowMinutes: query.window_minutes
    });
    res.json({ data: result });
  },

  async queueRebookNudges(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await rebookNudgesService.queueDueNudges(new Date(), query.limit);
    res.json({ data: result });
  },

  async processRebookNudges(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await rebookNudgesService.processQueuedNudgeEmails(new Date(), query.limit);
    res.json({ data: result });
  },

  async queueBirthdayReminders(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await birthdayRemindersService.queueUpcoming(new Date(), query.limit);
    res.json({ data: result });
  },

  async processBirthdayReminders(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await birthdayRemindersService.processQueuedBirthdayEmails(new Date(), query.limit);
    res.json({ data: result });
  },

  async queueThankYouEmails(req: Request, res: Response) {
    const query = req.query as {
      limit?: number;
      user_limit?: number;
      per_user_limit?: number;
    };
    const result = await thankYouEmailsService.queueDue(new Date(), {
      userLimit: query.user_limit,
      perUserLimit: query.per_user_limit ?? query.limit
    });
    res.json({ data: result });
  },

  async processThankYouEmails(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await thankYouEmailsService.processQueuedThankYouEmails(new Date(), query.limit);
    res.json({ data: result });
  },

  async purgeDeletedClients(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await clientPurgeService.purgeExpiredDeletedClients(new Date(), {
      limit: query.limit
    });
    res.json({ data: result });
  },

  async cleanupAppointmentImages(req: Request, res: Response) {
    const query = req.query as {
      limit?: number;
      dry_run?: boolean;
      include_orphans?: boolean;
      prefix?: string;
    };
    const [expiredPending, orphanedStorage] = await Promise.all([
      appointmentImageCleanupService.cleanupExpiredPendingUploads(new Date(), {
        limit: query.limit
      }),
      query.include_orphans === false
        ? Promise.resolve(null)
        : appointmentImageCleanupService.cleanupOrphanedStorageObjects({
            limit: query.limit,
            dryRun: query.dry_run !== false,
            prefix: query.prefix
          })
    ]);

    res.json({
      data: {
        expiredPending,
        orphanedStorage
      }
    });
  }
};
