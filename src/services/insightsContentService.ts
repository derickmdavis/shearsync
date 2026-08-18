import { appContentBundleService } from "./appContentBundleService";

/**
 * Published content overrides for backend-owned Insights copy. Until an
 * en-US revision is published, or if the content bundle is unavailable, the
 * current product copy remains the safe fallback.
 */
export const insightsContentService = {
  async load(): Promise<Record<string, string>> {
    try {
      return (await appContentBundleService.getPublishedBundle("en-US")).content;
    } catch {
      return {};
    }
  },

  text(content: Record<string, string>, key: string, fallback: string, values: Record<string, string | number> = {}): string {
    const template = content[key] ?? fallback;
    return template.replace(/\{\{([a-z][a-zA-Z0-9]*)\}\}/g, (match, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : match
    );
  }
};
