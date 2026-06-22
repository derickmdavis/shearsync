import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { appointmentPaymentsService } from "../services/appointmentPaymentsService";

export const appointmentPaymentsController = {
  async get(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const payment = await appointmentPaymentsService.get(userId, getRequiredParam(req, "appointmentId"));
    res.json({
      data: {
        payment,
        payment_notice: appointmentPaymentsService.paymentNotice
      }
    });
  },

  async markPaid(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const payment = await appointmentPaymentsService.markPaid(userId, getRequiredParam(req, "appointmentId"), req.body);
    res.status(201).json({
      data: {
        payment,
        payment_notice: appointmentPaymentsService.paymentNotice
      }
    });
  },

  async markUnpaid(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const payment = await appointmentPaymentsService.markUnpaid(userId, getRequiredParam(req, "appointmentId"));
    res.json({
      data: {
        payment,
        payment_notice: appointmentPaymentsService.paymentNotice
      }
    });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const payment = await appointmentPaymentsService.update(userId, getRequiredParam(req, "appointmentId"), req.body);
    res.json({
      data: {
        payment,
        payment_notice: appointmentPaymentsService.paymentNotice
      }
    });
  }
};
