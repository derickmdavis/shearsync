import { randomUUID } from "crypto";
import {
  APPOINTMENT_IMAGES_BUCKET,
  appointmentImageStorageService
} from "../services/appointmentImageStorageService";

const redactSignedUrl = (signedUrl: string): { origin: string; pathname: string; hasToken: boolean } => {
  const url = new URL(signedUrl);
  return {
    origin: url.origin,
    pathname: url.pathname,
    hasToken: url.searchParams.has("token")
  };
};

const getSmokeIds = () => ({
  userId: process.env.SMOKE_APPOINTMENT_IMAGE_USER_ID ?? randomUUID(),
  clientId: process.env.SMOKE_APPOINTMENT_IMAGE_CLIENT_ID ?? randomUUID(),
  appointmentId: process.env.SMOKE_APPOINTMENT_IMAGE_APPOINTMENT_ID ?? randomUUID(),
  imageId: process.env.SMOKE_APPOINTMENT_IMAGE_ID ?? randomUUID()
});

const main = async (): Promise<void> => {
  const ids = getSmokeIds();
  const paths = appointmentImageStorageService.generatePaths({
    ...ids,
    displayContentType: "image/jpeg",
    thumbnailContentType: "image/jpeg"
  });

  const uploadUrls = await appointmentImageStorageService.createSignedUploadUrls(paths);
  const readPath = process.env.SMOKE_APPOINTMENT_IMAGE_READ_PATH;
  const signedReadUrl = readPath
    ? await appointmentImageStorageService.createSignedReadUrl(readPath, 120)
    : null;

  console.log(JSON.stringify(
    {
      appointmentImageStorageSmoke: {
        bucket: APPOINTMENT_IMAGES_BUCKET,
        generatedPaths: paths,
        signedUploadUrls: {
          display: {
            path: uploadUrls.display.path,
            ...redactSignedUrl(uploadUrls.display.signedUrl)
          },
          thumbnail: {
            path: uploadUrls.thumbnail.path,
            ...redactSignedUrl(uploadUrls.thumbnail.signedUrl)
          }
        },
        signedReadUrl: signedReadUrl
          ? {
              path: readPath,
              ...redactSignedUrl(signedReadUrl)
            }
          : "skipped; set SMOKE_APPOINTMENT_IMAGE_READ_PATH to test signed reads for an existing object"
      }
    },
    null,
    2
  ));
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[APPOINTMENT_IMAGE_STORAGE_SMOKE] failed", error);
    process.exit(1);
  });
