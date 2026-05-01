import { ApiError } from "../lib/errors";
import { maskPhone, normalizePhone } from "../lib/phone";
import type { Row } from "./db";
import { bookingRulesService } from "./bookingRulesService";
import { clientsService } from "./clientsService";
import { servicesService } from "./servicesService";
import { stylistsService } from "./stylistsService";

type MatchStatus = "matched" | "not_found" | "ambiguous";
type RecommendedServiceReason = "last_completed_service" | "last_booked_service" | "default_service";

interface BookingBehaviorPreview {
  requiresApproval: boolean;
  restrictedToNewClientRules: boolean;
  canUseReturningClientRules: boolean;
  message: string;
}

interface BookingIntakeResponse {
  matchStatus: MatchStatus;
  clientFound: boolean;
  isExistingClient: boolean;
  bookingEnabled: boolean;
  candidateCount?: number;
  client: {
    id?: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phoneMasked: string;
  };
  submittedContact: {
    fullName: string;
    phoneNormalized: string;
    email: string | null;
  };
  recommendedService: {
    serviceId: string;
    serviceName: string;
    reason: RecommendedServiceReason;
  } | null;
  bookingBehavior: BookingBehaviorPreview;
  nextStep?: "collect_email_or_name";
}

const normalizeEmail = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
};

const splitFullName = (fullName: string): { firstName: string; lastName: string } => {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");

  return { firstName, lastName };
};

const normalizeServiceName = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

const toNewClientBehavior = (requiresApproval: boolean): BookingBehaviorPreview => ({
  requiresApproval,
  restrictedToNewClientRules: true,
  canUseReturningClientRules: false,
  message: requiresApproval
    ? "New client appointments may require approval."
    : "New client booking rules will apply."
});

const toAmbiguousBehavior = (requiresApproval: boolean): BookingBehaviorPreview => ({
  requiresApproval,
  restrictedToNewClientRules: true,
  canUseReturningClientRules: false,
  message: "We need a little more information before confirming returning-client status."
});

const toReturningBehavior = (): BookingBehaviorPreview => ({
  requiresApproval: false,
  restrictedToNewClientRules: false,
  canUseReturningClientRules: true,
  message: "Welcome back — you can book directly."
});

export const publicBookingIntakeService = {
  normalizePhoneOrThrow(phone: string): string {
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      throw new ApiError(400, "Phone number is invalid");
    }

    return normalizedPhone;
  },

  splitFullName,

  async lookupBookingIntake(input: Row): Promise<BookingIntakeResponse> {
    const stylist = await stylistsService.getBySlug(input.stylist_slug as string);
    const bookingEnabled = Boolean(stylist.booking_enabled);
    const fullName = (input.full_name as string).trim();
    const normalizedPhone = this.normalizePhoneOrThrow(input.phone as string);
    const email = normalizeEmail(input.email as string | undefined);
    const parsedName = splitFullName(fullName);
    const userId = stylist.user_id as string;
    const bookingRules = await bookingRulesService.getByUserId(userId);
    const requiresNewClientApproval = bookingRules.newClientApprovalRequired;
    const phoneMasked = maskPhone(normalizedPhone);

    if (!bookingEnabled) {
      return {
        matchStatus: "not_found",
        clientFound: false,
        isExistingClient: false,
        bookingEnabled,
        client: {
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          email: email ?? null,
          phoneMasked
        },
        submittedContact: {
          fullName,
          phoneNormalized: normalizedPhone,
          email: email ?? null
        },
        recommendedService: null,
        bookingBehavior: toNewClientBehavior(requiresNewClientApproval)
      };
    }

    const matches = await clientsService.findBookingMatches(userId, {
      phone: input.phone,
      email
    });

    if (matches.length > 1) {
      return {
        matchStatus: "ambiguous",
        clientFound: false,
        isExistingClient: false,
        bookingEnabled,
        candidateCount: matches.length,
        client: {
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          email: email ?? null,
          phoneMasked
        },
        submittedContact: {
          fullName,
          phoneNormalized: normalizedPhone,
          email: email ?? null
        },
        recommendedService: null,
        bookingBehavior: toAmbiguousBehavior(requiresNewClientApproval),
        nextStep: "collect_email_or_name"
      };
    }

    const matchedClient = matches[0] ?? null;

    if (!matchedClient) {
      return {
        matchStatus: "not_found",
        clientFound: false,
        isExistingClient: false,
        bookingEnabled,
        client: {
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          email: email ?? null,
          phoneMasked
        },
        submittedContact: {
          fullName,
          phoneNormalized: normalizedPhone,
          email: email ?? null
        },
        recommendedService: null,
        bookingBehavior: toNewClientBehavior(requiresNewClientApproval)
      };
    }

    const recommendedService = await this.getRecommendedService(userId, matchedClient.id as string);
    const matchedEmail = normalizeEmail(matchedClient.email as string | undefined);

    return {
      matchStatus: "matched",
      clientFound: true,
      isExistingClient: true,
      bookingEnabled,
      client: {
        id: matchedClient.id as string,
        firstName: (matchedClient.first_name as string | undefined) ?? parsedName.firstName,
        lastName: (matchedClient.last_name as string | undefined) ?? parsedName.lastName,
        email: matchedEmail ?? email ?? null,
        phoneMasked
      },
      submittedContact: {
        fullName,
        phoneNormalized: normalizedPhone,
        email: email ?? matchedEmail ?? null
      },
      recommendedService,
      bookingBehavior: toReturningBehavior()
    };
  },

  async getRecommendedService(userId: string, clientId: string): Promise<BookingIntakeResponse["recommendedService"]> {
    const [services, appointments] = await Promise.all([
      servicesService.listActiveByUserId(userId),
      clientsService.listBookingRelevantAppointments(userId, clientId)
    ]);

    const servicesByName = new Map<string, Row>();
    let defaultService: Row | null = null;

    for (const service of services) {
      const name = service.name;
      if (typeof name === "string") {
        servicesByName.set(normalizeServiceName(name), service);
      }

      if (!defaultService && service.is_default === true) {
        defaultService = service;
      }
    }

    const completedAppointment = appointments.find((appointment) => appointment.status === "completed");
    if (completedAppointment) {
      const service = servicesByName.get(normalizeServiceName(completedAppointment.service_name as string));
      if (service) {
        return {
          serviceId: service.id as string,
          serviceName: service.name as string,
          reason: "last_completed_service"
        };
      }
    }

    const lastBookedAppointment = appointments.find((appointment) => appointment.status !== "cancelled");
    if (lastBookedAppointment) {
      const service = servicesByName.get(normalizeServiceName(lastBookedAppointment.service_name as string));
      if (service) {
        return {
          serviceId: service.id as string,
          serviceName: service.name as string,
          reason: "last_booked_service"
        };
      }
    }

    if (defaultService) {
      return {
        serviceId: defaultService.id as string,
        serviceName: defaultService.name as string,
        reason: "default_service"
      };
    }

    return null;
  }
};
