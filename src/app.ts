import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { requestObservability } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRouter } from "./routes";

const allowedOrigins = [env.CLIENT_APP_URL, env.WEB_APP_URL].filter(Boolean) as string[];

export const isCorsOriginAllowed = ({
  origin,
  origins,
  nodeEnv
}: {
  origin: string | undefined;
  origins: string[];
  nodeEnv: string;
}): boolean => {
  // Non-browser callers (Twilio, cron, and server-to-server requests) do not
  // send Origin and are not subject to CORS.
  if (!origin || origins.includes(origin)) {
    return true;
  }

  // Local development remains convenient without a configured frontend. In
  // production, env validation requires an allowlist and unknown origins fail closed.
  return nodeEnv !== "production" && origins.length === 0;
};

export const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(requestObservability);
app.use(
  cors({
    origin(origin, callback) {
      if (isCorsOriginAllowed({ origin, origins: allowedOrigins, nodeEnv: env.NODE_ENV })) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json({
  limit: "1mb",
  verify(req, _res, buffer) {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({
  extended: false,
  limit: "1mb",
  verify(req, _res, buffer) {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  }
}));

app.use(apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);
