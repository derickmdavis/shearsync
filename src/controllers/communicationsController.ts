import type { Request, Response } from "express";
import { getRequiredParam } from "../lib/request";
import { ApiError } from "../lib/errors";
import { communicationsService } from "../services/communicationsService";
import { smsDeliveryStatusService } from "../services/smsDeliveryStatusService";
import { parseTwilioInboundSms } from "../lib/twilioInboundSms";
import { smsInboundEventsService } from "../services/smsInboundEventsService";

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

const getSmsStatusDiagnostics = (body: unknown): Record<string, string> => {
  const diagnostics: Record<string, string> = {};
  for (const key of ["RawDlrDoneDate", "ChannelPrefix", "ApiVersion"]) {
    const value = getBodyString(body, key);
    if (value) diagnostics[key] = value.slice(0, 200);
  }
  return diagnostics;
};

const escapeXml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const twimlResponse = (message?: string): string =>
  message ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

export const communicationsController = {
  async unsubscribe(req: Request, res: Response) {
    const body = await communicationsService.unsubscribe(getRequiredParam(req, "token"), {
      ipAddress: getIpAddress(req),
      userAgent: getUserAgent(req)
    });

    res.status(200).type("html").send(body);
  },

  async inboundSms(req: Request, res: Response) {
    const inbound = parseTwilioInboundSms(req.body);
    const claim = await smsInboundEventsService.claimTwilioInboundEvent(inbound);
    if (!claim.claimed) {
      // A completed event is safely idempotent. An active lease must be retried rather than
      // acknowledged as complete, so a crashed worker cannot lose the inbound command.
      if (!claim.processed) throw new ApiError(503, "Inbound SMS event is still processing");
      res.status(200).type("text/xml").send(twimlResponse());
      return;
    }
    if (!claim.event?.id || !claim.leaseToken) throw new Error("Inbound SMS event claim is incomplete");
    try {
      const reply = await communicationsService.handleInboundSms({
        from: inbound.from, to: inbound.to,
        body: inbound.classification === "other" ? inbound.body : inbound.classification.toUpperCase(),
        messageSid: inbound.messageSid, classification: inbound.classification,
        classificationSource: inbound.classificationSource, providerOptOutType: inbound.providerMetadata.opt_out_type,
        inboundEventId: String(claim.event.id), ipAddress: getIpAddress(req), userAgent: getUserAgent(req)
      });
      const completed = await smsInboundEventsService.markProcessed(String(claim.event.id), claim.leaseToken);
      if (!completed) throw new Error("Inbound SMS event lease was lost before completion");

      // Advanced Opt-Out already sends Twilio's compliant reply for this callback.
      res.status(200).type("text/xml").send(
        twimlResponse(inbound.classificationSource === "twilio_opt_out_type" ? undefined : reply)
      );
    } catch (error) {
      await smsInboundEventsService.markFailed(String(claim.event.id), claim.leaseToken);
      throw error;
    }
  },

  async smsStatus(req: Request, res: Response) {
    await smsDeliveryStatusService.applyTwilioStatus({
      messageSid: getBodyString(req.body, "MessageSid"),
      messageStatus: getBodyString(req.body, "MessageStatus"),
      errorCode: getBodyString(req.body, "ErrorCode"),
      errorMessage: getBodyString(req.body, "ErrorMessage"),
      to: getBodyString(req.body, "To"),
      providerDiagnostics: getSmsStatusDiagnostics(req.body)
    });
    res.status(204).send();
  }
};
