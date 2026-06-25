import { ApiError } from "../lib/errors";
import { getAppointmentEndIso } from "../lib/appointments";
import {
  formatInstantInTimeZoneOffset,
  zonedDateTimeToUtc
} from "../lib/timezone";
import type { PublicBookingConfirmation } from "../types/api";
import { appointmentsService } from "./appointmentsService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import type { Row } from "./db";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";
import { usersService } from "./usersService";
import { publicBookingIntakeService } from "./publicBookingIntakeService";
import { appointmentEmailEventsService } from "./appointmentEmailEventsService";
import { schedulingPolicyService } from "./schedulingPolicyService";
import { referralLinksService, type ReferralAttribution } from "./referralLinksService";
import { resolvePublicBookingContextToken } from "../lib/publicBookingContext";
import {
  createPublicAppointmentImageUploadToken,
  getPublicAppointmentImageUploadExpiresAt
} from "../lib/publicAppointmentImageUpload";
import { bookingErrorEventsService } from "./bookingErrorEventsService";
import { recordProductTelemetry } from "./productTelemetry";

const requestedDateTimePattern = /^(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<millisecond>\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})$/;

const normalizeRequestedDateTimeForBusinessTimeZone = (
  requestedDateTime: string,
  timeZone: string
): string => {
  const match = requestedDateTimePattern.exec(requestedDateTime);

  if (!match?.groups) {
    throw new ApiError(400, "Requested datetime is invalid");
  }

  const secondText = match.groups.second ?? "00";
  const millisecondText = match.groups.millisecond ?? "0";
  const millisecond = Number(millisecondText.padEnd(3, "0").slice(0, 3));

  return zonedDateTimeToUtc(
    match.groups.date,
    timeZone,
    Number(match.groups.hour),
    Number(match.groups.minute),
    Number(secondText),
    millisecond
  ).toISOString();
};

const buildConfirmation = async ({
  appointment,
  stylist,
  service,
  userId,
  serviceDurationMinutes
}: {
  appointment: Row;
  stylist: Row;
  service: Row;
  userId: string;
  serviceDurationMinutes: number;
}): Promise<PublicBookingConfirmation> => {
  const [timeZone, user] = await Promise.all([
    businessTimeZoneService.getForUser(userId),
    usersService.getById(userId)
  ]);
  const appointmentStartTime = appointment.appointment_date as string;

  return {
    appointment_id: appointment.id as string,
    client_id: appointment.client_id as string,
    stylist_slug: stylist.slug as string,
    stylist_display_name: stylist.display_name as string,
    business_name: (user?.business_name as string | null | undefined) ?? null,
    service_id: service.id as string,
    service_name: service.name as string,
    service_duration_minutes: serviceDurationMinutes,
    service_price: Number(service.price ?? 0),
    appointment_date: appointmentStartTime,
    appointment_end: formatInstantInTimeZoneOffset(
      getAppointmentEndIso(appointmentStartTime, serviceDurationMinutes),
      timeZone
    ),
    business_timezone: timeZone,
    status: appointment.status as PublicBookingConfirmation["status"],
    reference_photo_upload_token: createPublicAppointmentImageUploadToken({
      appointmentId: appointment.id as string,
      clientId: appointment.client_id as string,
      stylistId: userId,
      appointmentStartTime
    }),
    reference_photo_upload_token_expires_at: getPublicAppointmentImageUploadExpiresAt(appointmentStartTime)
  };
};

const queuePublicBookingEmail = async (
  userId: string,
  appointment: Row,
  recipientEmail?: string | null
): Promise<void> => {
  const status = appointment.status as string | undefined;

  try {
    if (status === "scheduled") {
      await appointmentEmailEventsService.queueAppointmentEmail(userId, appointment, "appointment_scheduled", {
        recipientEmail
      });
    }

    if (status === "pending") {
      await appointmentEmailEventsService.queueAppointmentEmail(userId, appointment, "appointment_pending", {
        recipientEmail
      });
    }
  } catch (error) {
    console.warn("[PUBLIC_BOOKING_EMAIL] failed to queue appointment email", {
      userId,
      appointmentId: appointment.id,
      status,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const findMatchingPublicBookingForClients = async (
  userId: string,
  clients: Row[],
  {
    appointmentDate,
    serviceName,
    durationMinutes
  }: {
    appointmentDate: string;
    serviceName: string;
    durationMinutes: number;
  }
): Promise<Row | null> => {
  const seenClientIds = new Set<string>();

  for (const client of clients) {
    const clientId = client.id;
    if (typeof clientId !== "string" || seenClientIds.has(clientId)) {
      continue;
    }

    seenClientIds.add(clientId);
    const existingAppointment = await appointmentsService.findMatchingPublicBooking(userId, {
      clientId,
      appointmentDate,
      serviceName,
      durationMinutes
    });

    if (existingAppointment) {
      return existingAppointment;
    }
  }

  return null;
};

const persistGuestEmailIfMissing = async (
  userId: string,
  client: Row,
  guestEmail?: string
): Promise<Row> => {
  const storedEmail = typeof client.email === "string" ? client.email.trim() : "";

  if (!guestEmail || storedEmail.length > 0) {
    return client;
  }

  return clientsService.update(userId, client.id as string, { email: guestEmail });
};

const getAppointmentEnd = (appointmentDate: string, durationMinutes: number): string =>
  getAppointmentEndIso(appointmentDate, durationMinutes);

const conflictDiagnosticsVersion = "slot-conflicts-v1";

const toAppointmentReferralFields = (attribution: ReferralAttribution | null): Row => attribution
  ? {
      referral_link_id: attribution.referralLinkId,
      referred_by_client_id: attribution.referredByClientId,
      referral_code_used: attribution.referralCodeUsed,
      referral_attributed_at: attribution.referralAttributedAt,
      acquisition_source: attribution.acquisitionSource
    }
  : {};

const toNewClientReferralFields = (attribution: ReferralAttribution | null): Row => attribution
  ? {
      source: "referral",
      original_referral_link_id: attribution.referralLinkId,
      original_referred_by_client_id: attribution.referredByClientId,
      original_referral_code: attribution.referralCodeUsed,
      original_acquisition_source: attribution.acquisitionSource,
      original_referral_attributed_at: attribution.referralAttributedAt
    }
  : {};

export const publicBookingsService = {
  async create(payload: Row): Promise<PublicBookingConfirmation> {
    const stylist = await stylistsService.getBySlug(payload.stylist_slug as string);
    stylistsService.assertPublicBookingEnabled(stylist);

    const userId = stylist.user_id as string;
    const service = await servicesService.getActiveForStylist(userId, payload.service_id as string);

    if (!service) {
      throw new ApiError(400, "Selected service is not available");
    }

    const timeZone = await businessTimeZoneService.getForUser(userId);
    const requestedDateTime = normalizeRequestedDateTimeForBusinessTimeZone(
      payload.requested_datetime as string,
      timeZone
    );
    const serviceDurationMinutes = Number(service.duration_minutes ?? 0);
    const normalizedGuestPhone = publicBookingIntakeService.normalizePhoneOrThrow(payload.guest_phone as string);
    const normalizedGuestEmail = typeof payload.guest_email === "string" ? payload.guest_email.trim().toLowerCase() : undefined;
    const matchedClient = await clientsService.findMatchingForBooking(userId, {
      email: normalizedGuestEmail,
      phone: normalizedGuestPhone
    }, {
      includeEmail: true
    });
    const referralAttributionResult = await referralLinksService.resolveAttributionForBooking({
      stylistId: userId,
      referralCode: typeof payload.referral_code === "string" ? payload.referral_code : null,
      matchedClientId: typeof matchedClient?.id === "string" ? matchedClient.id : null,
      guestPhone: normalizedGuestPhone,
      guestEmail: normalizedGuestEmail
    });
    const referralAttribution = referralAttributionResult.attribution;
    const bookingContext = resolvePublicBookingContextToken(
      typeof payload.booking_context_token === "string" ? payload.booking_context_token : undefined,
      stylist.slug as string
    );
    const isExistingClient = bookingContext?.isExistingClient ?? Boolean(matchedClient);

    const slotEvaluation = await schedulingPolicyService.evaluateRequestedSlot({
      userId,
      serviceId: service.id as string,
      requestedDateTime,
      durationMinutes: serviceDurationMinutes,
      mode: "booking",
      isExistingClient
    });
    const validationDetails = {
      reason: slotEvaluation.ok ? undefined : slotEvaluation.reason,
      requestedDateTime,
      bookingContextTokenPresent: typeof payload.booking_context_token === "string",
      bookingContextIsExistingClient: bookingContext?.isExistingClient ?? null,
      matchedClientFound: Boolean(matchedClient),
      finalIsExistingClient: isExistingClient,
      conflictDiagnosticsVersion: slotEvaluation.ok || slotEvaluation.reason !== "appointment_conflict"
        ? undefined
        : conflictDiagnosticsVersion,
      conflicts: slotEvaluation.ok || slotEvaluation.reason !== "appointment_conflict"
        ? undefined
        : (slotEvaluation.conflicts ?? []).map((conflict) => ({
          id: conflict.id,
          start: conflict.appointment_date,
          end: getAppointmentEnd(conflict.appointment_date, conflict.duration_minutes),
          durationMinutes: conflict.duration_minutes,
          status: conflict.status
        }))
    };

    if (!slotEvaluation.ok) {
      if (slotEvaluation.reason === "appointment_conflict" && matchedClient) {
        const existingAppointment = await findMatchingPublicBookingForClients(userId, [matchedClient], {
          appointmentDate: requestedDateTime,
          serviceName: service.name as string,
          durationMinutes: serviceDurationMinutes
        });

        if (existingAppointment) {
          await queuePublicBookingEmail(userId, existingAppointment, normalizedGuestEmail);

          return buildConfirmation({
            appointment: existingAppointment,
            stylist,
            service,
            userId,
            serviceDurationMinutes
          });
        }
      }

      if (slotEvaluation.reason === "appointment_conflict" && !matchedClient) {
        const latestMatchedClients = await clientsService.findBookingMatchesIncludingEmail(userId, {
          email: normalizedGuestEmail,
          phone: normalizedGuestPhone
        });
        const existingAppointment = await findMatchingPublicBookingForClients(userId, latestMatchedClients, {
          appointmentDate: requestedDateTime,
          serviceName: service.name as string,
          durationMinutes: serviceDurationMinutes
        });

        if (existingAppointment) {
          await queuePublicBookingEmail(userId, existingAppointment, normalizedGuestEmail);

          return buildConfirmation({
            appointment: existingAppointment,
            stylist,
            service,
            userId,
            serviceDurationMinutes
          });
        }
      }

      await bookingErrorEventsService.recordBookingError({
        accountUserId: userId,
        stylistSlug: stylist.slug as string,
        step: "booking_submission",
        errorCode: slotEvaluation.reason === "appointment_conflict" ? "booking_conflict" : "slot_unavailable",
        severity: "warning",
        errorMessage: slotEvaluation.message,
        metadata: validationDetails
      });
      await recordProductTelemetry({
        accountUserId: userId,
        eventType: "public_booking_submission_failed",
        eventSource: "public_booking",
        stylistSlug: stylist.slug as string,
        metadata: {
          stylist_slug: stylist.slug,
          service_id: service.id ?? null,
          source: "public_booking",
          reason: slotEvaluation.reason
        }
      });

      throw new ApiError(slotEvaluation.statusCode, slotEvaluation.message, validationDetails, {
        exposeDetails: true
      });
    }

    const resolvedClient = matchedClient ?? await clientsService.create(userId, {
      first_name: payload.guest_first_name,
      last_name: payload.guest_last_name,
      email: normalizedGuestEmail,
      phone: payload.guest_phone,
      ...toNewClientReferralFields(referralAttribution)
    });
    const client = await persistGuestEmailIfMissing(userId, resolvedClient, normalizedGuestEmail);

    try {
      const appointment = await appointmentsService.createForBooking(userId, {
        client_id: client.id,
        service_id: service.id,
        appointment_date: requestedDateTime,
        service_name: service.name,
        duration_minutes: serviceDurationMinutes,
        price: service.price,
        notes: payload.notes,
        status: slotEvaluation.status,
        booking_source: "public",
        ...toAppointmentReferralFields(referralAttribution)
      });

      if (referralAttribution) {
        await referralLinksService.recordBookingAttributed(referralAttribution.referralCodeUsed, appointment.id as string, {
          booked_client_id: client.id,
          is_existing_client: Boolean(matchedClient)
        });
      }

      await recordProductTelemetry({
        accountUserId: userId,
        clientId: typeof client.id === "string" ? client.id : null,
        appointmentId: typeof appointment.id === "string" ? appointment.id : null,
        eventType: "public_booking_submitted",
        eventSource: "public_booking",
        stylistSlug: stylist.slug as string,
        dedupeKey: typeof appointment.id === "string" ? `public_booking_submitted:${appointment.id}` : null,
        metadata: {
          stylist_slug: stylist.slug,
          service_id: service.id ?? null,
          source: "public_booking",
          status: appointment.status ?? null,
          is_existing_client: Boolean(matchedClient),
          has_referral: Boolean(referralAttribution)
        }
      });

      await queuePublicBookingEmail(userId, appointment, normalizedGuestEmail);

      return buildConfirmation({
        appointment,
        stylist,
        service,
        userId,
        serviceDurationMinutes
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 409) {
        throw error;
      }

      const latestMatchedClients = await clientsService.findBookingMatchesIncludingEmail(userId, {
        email: normalizedGuestEmail,
        phone: normalizedGuestPhone
      });
      const existingAppointment = await findMatchingPublicBookingForClients(userId, [client, ...latestMatchedClients], {
        appointmentDate: requestedDateTime,
        serviceName: service.name as string,
        durationMinutes: serviceDurationMinutes
      });

      if (!existingAppointment) {
        await bookingErrorEventsService.recordBookingError({
          accountUserId: userId,
          clientId: typeof client.id === "string" ? client.id : null,
          stylistSlug: stylist.slug as string,
          step: "booking_submission",
          errorCode: "booking_insert_failed",
          severity: "warning",
          errorMessage: "Requested time is no longer available",
          metadata: {
            ...validationDetails,
            reason: "appointment_write_conflict"
          }
        });
        await recordProductTelemetry({
          accountUserId: userId,
          clientId: typeof client.id === "string" ? client.id : null,
          eventType: "public_booking_submission_failed",
          eventSource: "public_booking",
          stylistSlug: stylist.slug as string,
          metadata: {
            stylist_slug: stylist.slug,
            service_id: service.id ?? null,
            source: "public_booking",
            reason: "appointment_write_conflict"
          }
        });

        throw new ApiError(409, "Requested time is no longer available", {
          ...validationDetails,
          reason: "appointment_write_conflict"
        }, {
          exposeDetails: true
        });
      }

      await queuePublicBookingEmail(userId, existingAppointment, normalizedGuestEmail);

      return buildConfirmation({
        appointment: existingAppointment,
        stylist,
        service,
        userId,
        serviceDurationMinutes
      });
    }
  }
};
