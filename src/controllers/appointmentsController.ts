import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { appointmentsService } from "../services/appointmentsService";
import { activityEventsService } from "../services/activityEventsService";

export const appointmentsController = {
  async getInternalContext(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const context = await appointmentsService.getInternalContext(
      userId,
      req.query.date as string,
      Number(req.query.durationMinutes)
    );
    res.json({ data: context });
  },

  async listByClient(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const appointments = await appointmentsService.listByClient(userId, getRequiredParam(req, "id"));
    res.json({ data: appointments });
  },

  async listActivity(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const events = await activityEventsService.listByAppointment(userId, getRequiredParam(req, "id"));
    res.json({ data: { events } });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const appointment = await appointmentsService.create(userId, req.body);
    res.status(201).json({ data: appointment });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const appointment = await appointmentsService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: appointment });
  },

  async applyPendingDecision(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const appointment = await appointmentsService.applyPendingDecision(
      userId,
      getRequiredParam(req, "id"),
      req.body.decision as "accept" | "reject"
    );
    res.json({ data: appointment });
  }
};
