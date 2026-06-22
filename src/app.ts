import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { requestObservability } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRouter } from "./routes";

const allowedOrigins = [env.CLIENT_APP_URL, env.WEB_APP_URL].filter(Boolean) as string[];

export const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(requestObservability);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);
