import { logger } from "../lib/logger";
import { clientFormulaCleanupService } from "../services/clientFormulaCleanupService";
clientFormulaCleanupService.purgeExpiredArchivedFormulas().then((result) => { logger.info("archived_client_formulas_purged", result); process.exit(0); }).catch((error: unknown) => { logger.error("archived_client_formulas_purge_failed", { errorMessage: error instanceof Error ? error.message : String(error) }); process.exit(1); });
