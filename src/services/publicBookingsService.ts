import { ApiError } from "../lib/errors";
import {
  addDays,
  formatInstantInTimeZoneOffset,
  getCurrentLocalDate,
  getLocalDateForInstant,
  getMinutesSinceMidnightForInstant,
  zonedDateTimeToUtc
} from "../lib/timezone";
import type { PublicBookingConfirmation } from "../types/api";
import { appointmentsService } from "./appointmentsService";
import { availabilityService } from "./availabilityService";
import { bookingRulesService } from "./bookingRulesService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import type { Row } from "./db";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";
import { usersService } from "./usersService";
import { publicBookingIntakeService } from "./publicBookingIntakeService";

const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const getAppointmentEndIso = (appointmentDate: string, durationMinutes: number): string =>
  new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString();

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
    appointment_date: appointment.appointment_date as string,
    appointment_end: formatInstantInTimeZoneOffset(
      getAppointmentEndIso(appointment.appointment_date as string, serviceDurationMinutes),
      timeZone
    ),
    business_timezone: timeZone,
    status: appointment.status as PublicBookingConfirmation["status"]
  };
};

const validateBookingRules = async ({
  userId,
  serviceId,
  requestedDateTime,
  isExistingClient
}: {
  userId: string;
  serviceId: string;
  requestedDateTime: string;
  isExistingClient: boolean;
}): Promise<"pending" | "scheduled"> => {
  const rules = await bookingRulesService.getByUserId(userId);
  const timeZone = await businessTimeZoneService.getForUser(userId);
  const now = new Date();
  const requestedDate = new Date(requestedDateTime);
  const requestedLocalDate = getLocalDateForInstant(requestedDateTime, timeZone);
  const today = getCurrentLocalDate(timeZone, now);
  let nextStatus: "pending" | "scheduled" = "scheduled";

  if (requestedDate <= now) {
    throw new ApiError(400, "Requested time must be in the future");
  }

  const leadTimeThreshold = new Date(now.getTime() + rules.leadTimeHours * 60 * 60_000);
  if (requestedDate < leadTimeThreshold) {
    throw new ApiError(400, `Appointments require at least ${rules.leadTimeHours} hour(s) of notice`);
  }

  if (requestedLocalDate > addDays(today, rules.maxBookingWindowDays)) {
    throw new ApiError(400, `Appointments can only be booked up to ${rules.maxBookingWindowDays} day(s) in advance`);
  }

  if (requestedLocalDate === today) {
    if (!rules.sameDayBookingAllowed) {
      throw new ApiError(400, "Same-day booking is not allowed");
    }

    const currentLocalMinutes = getMinutesSinceMidnightForInstant(now.toISOString(), timeZone);
    if (currentLocalMinutes > timeToMinutes(rules.sameDayBookingCutoff)) {
      throw new ApiError(400, "The same-day booking cutoff has passed");
    }
  }

  if (!isExistingClient) {
    if (rules.newClientApprovalRequired) {
      nextStatus = "pending";
    }

    if (
      rules.newClientBookingWindowDays > 0
      && requestedLocalDate > addDays(today, rules.newClientBookingWindowDays)
    ) {
      throw new ApiError(400, `New clients can only book up to ${rules.newClientBookingWindowDays} day(s) in advance`);
    }

    if (rules.restrictServicesForNewClients && rules.restrictedServiceIds.includes(serviceId)) {
      throw new ApiError(400, "This service is not available for new clients online");
    }
  }

  return nextStatus;
};

export const publicBookingsService = {
  async create(payload: Row): Promise<PublicBookingConfirmation> {
    const stylist = await stylistsService.getBySlug(payload.stylist_slug as string);

    if (!stylist.booking_enabled) {
      throw new ApiError(400, "Online booking is not enabled for this stylist");
    }

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
    });
    const isExistingClient = Boolean(matchedClient);

    const bookingStatus = await validateBookingRules({
      userId,
      serviceId: service.id as string,
      requestedDateTime,
      isExistingClient
    });

    const isAvailable = await availabilityService.isRequestedTimeAvailable(
      userId,
      requestedDateTime,
      serviceDurationMinutes
    );

    if (!isAvailable) {
      throw new ApiError(409, "Requested time is no longer available");
    }

    const client = matchedClient ?? await clientsService.findOrCreateForBooking(userId, {
      first_name: payload.guest_first_name,
      last_name: payload.guest_last_name,
      email: normalizedGuestEmail,
      phone: payload.guest_phone,
      notes: payload.notes
    });

    try {
      const appointment = await appointmentsService.createForBooking(userId, {
        client_id: client.id,
        appointment_date: requestedDateTime,
        service_name: service.name,
        duration_minutes: serviceDurationMinutes,
        price: service.price,
        notes: payload.notes,
        status: bookingStatus,
        booking_source: "public"
      });

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

      const existingAppointment = await appointmentsService.findMatchingPublicBooking(userId, {
        clientId: client.id as string,
        appointmentDate: requestedDateTime,
        serviceName: service.name as string,
        durationMinutes: serviceDurationMinutes
      });

      if (!existingAppointment) {
        throw error;
      }

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
