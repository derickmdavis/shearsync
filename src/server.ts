import { app } from "./app";
import { schemaReadinessService } from "./services/schemaReadinessService";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const start = async () => {
  await schemaReadinessService.assertReady();

  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
};

start().catch((error) => {
  console.error("API startup failed", error);
  process.exit(1);
});
