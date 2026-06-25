import type { Request, Response } from "express";
import { ApiError } from "../lib/errors";
import { adminAccountNotesService } from "../services/adminAccountNotesService";
import { adminDashboardService } from "../services/adminDashboardService";

const getRequiredParam = (req: Request, name: string): string => {
  const value = req.params[name];
  if (!value) {
    throw new ApiError(400, `Missing ${name}`);
  }

  return Array.isArray(value) ? value[0] : value;
};

export const adminController = {
  async getSystemHealth(_req: Request, res: Response) {
    res.json({ data: await adminDashboardService.getSystemHealth() });
  },

  async getBusinessOverview(req: Request, res: Response) {
    res.json({ data: await adminDashboardService.getBusinessOverview(String(req.query.range ?? "30d")) });
  },

  async getAccounts(req: Request, res: Response) {
    res.json({ data: await adminDashboardService.getAccounts(String(req.query.range ?? "30d")) });
  },

  async getAccountDetail(req: Request, res: Response) {
    res.json({
      data: await adminDashboardService.getAccountDetail(
        getRequiredParam(req, "userId"),
        String(req.query.range ?? "30d")
      )
    });
  },

  async listAccountNotes(req: Request, res: Response) {
    res.json({ data: await adminAccountNotesService.listNotes(getRequiredParam(req, "userId")) });
  },

  async createAccountNote(req: Request, res: Response) {
    if (!req.admin?.email) {
      throw new ApiError(403, "Admin access required");
    }

    const note = typeof req.body?.note === "string" ? req.body.note : "";
    if (!note.trim()) {
      throw new ApiError(400, "Note is required");
    }

    const created = await adminAccountNotesService.createNote({
      accountUserId: getRequiredParam(req, "userId"),
      createdByAdminEmail: req.admin.email,
      note,
      metadata: req.body?.metadata
    });

    res.status(201).json({ data: created });
  }
};
