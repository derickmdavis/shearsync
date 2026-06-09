import type { Request, Response } from "express";
import { getRequiredParam } from "../lib/request";
import { communicationsService } from "../services/communicationsService";

const getIpAddress = (req: Request): string | null =>
  typeof req.ip === "string" ? req.ip : null;

const getUserAgent = (req: Request): string | null => {
  const value = req.get("user-agent");
  return typeof value === "string" ? value : null;
};

const getBodyString = (body: unknown, key: string): string | null => {
  if (!body || typeof body !== "object") {
    return null;
  }

  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

export const communicationsController = {
  async unsubscribe(req: Request, res: Response) {
    const body = await communicationsService.unsubscribe(getRequiredParam(req, "token"), {
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req)
    });

    res.status(200).type("html").send(body);
  },

  async inboundSms(req: Request, res: Response) {
    const reply = await communicationsService.handleInboundSms({
      from: getBodyString(req.body, "From") ?? getBodyString(req.body, "from"),
      to: getBodyString(req.body, "To") ?? getBodyString(req.body, "to"),
      body: getBodyString(req.body, "Body") ?? getBodyString(req.body, "body"),
      messageSid: getBodyString(req.body, "MessageSid") ?? getBodyString(req.body, "messageSid"),
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req)
    });

    res.status(200).type("text/plain").send(reply);
  }
};
