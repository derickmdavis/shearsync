import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { isValidConfiguredTwilioWebhook } from "../lib/twilioWebhook";

/** Rejects unsigned or invalid Twilio form callbacks before they reach application logic. */
export const requireValidTwilioWebhook = (req: Request, res: Response, next: NextFunction): void => {
  // SMS callbacks are not a public API surface until Twilio is explicitly selected.
  if (env.SMS_PROVIDER !== "twilio") {
    res.status(404).json({ error: { message: "Not found." } });
    return;
  }
  const signature = req.get("X-Twilio-Signature") ?? undefined;
  if (!isValidConfiguredTwilioWebhook({ signature, originalUrl: req.originalUrl, body: req.body })) {
    res.status(403).json({ error: { message: "Invalid Twilio webhook signature." } });
    return;
  }
  next();
};
