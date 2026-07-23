import type { Request, Response } from "express";
import {
  appContentBundleService,
  createAppContentEtag,
  ifNoneMatchMatches
} from "../services/appContentBundleService";
import { logger } from "../lib/logger";

const CACHE_CONTROL = "private, max-age=300, stale-while-revalidate=86400";

export const appContentController = {
  async getPublishedBundle(req: Request, res: Response) {
    const requestedLocale = (req.query as { locale: string }).locale;
    const bundle = await appContentBundleService.getPublishedBundle(requestedLocale);
    const etag = createAppContentEtag(bundle);

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.setHeader("Vary", "Authorization");

    if (ifNoneMatchMatches(req.header("if-none-match"), etag)) {
      logger.info("app_content_bundle_not_modified", {
        requestId: req.requestId,
        requestedLocale,
        locale: bundle.locale,
        version: bundle.version,
        fallbackApplied: bundle.fallbackApplied
      });
      res.status(304).end();
      return;
    }

    logger.info("app_content_bundle_served", {
      requestId: req.requestId,
      requestedLocale,
      locale: bundle.locale,
      version: bundle.version,
      fallbackApplied: bundle.fallbackApplied,
      contentKeyCount: Object.keys(bundle.content).length
    });

    res.json({
      data: {
        version: bundle.version,
        locale: bundle.locale,
        requested_locale: bundle.requestedLocale,
        fallback_applied: bundle.fallbackApplied,
        revision_id: bundle.revisionId,
        published_at: bundle.publishedAt,
        content: bundle.content
      }
    });
  }
};
