import { getCurrentLocalDate, getLocalDateForInstant } from "../lib/timezone";
import type { Row } from "./db";

const REBOOK_MIN_MONTHS = 3;
const REBOOK_MAX_MONTHS = 6;

const pad = (value: number): string => String(value).padStart(2, "0");

const shiftDateTextByMonths = (dateText: string, deltaMonths: number): string => {
  const [yearText, monthText, dayText] = dateText.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const absoluteMonthIndex = year * 12 + monthIndex + deltaMonths;
  const targetYear = Math.floor(absoluteMonthIndex / 12);
  const targetMonthIndex = ((absoluteMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);

  return `${targetYear}-${pad(targetMonthIndex + 1)}-${pad(targetDay)}`;
};

export interface ClientRebookEvaluation {
  lastQualifyingPastAppointment: Row | null;
  needsRebook: boolean;
}

export const evaluateClientRebookStatus = (
  appointments: Row[],
  timeZone: string,
  now = new Date()
): ClientRebookEvaluation => {
  const currentLocalDate = getCurrentLocalDate(timeZone, now);
  const nowIso = now.toISOString();
  const rebookWindowStartDate = shiftDateTextByMonths(currentLocalDate, -REBOOK_MAX_MONTHS);
  const rebookWindowEndDate = shiftDateTextByMonths(currentLocalDate, -REBOOK_MIN_MONTHS);

  const hasFutureAppointment = appointments.some((appointment) => {
    const appointmentDate = appointment.appointment_date;
    return typeof appointmentDate === "string" && appointmentDate > nowIso;
  });

  if (hasFutureAppointment) {
    return {
      lastQualifyingPastAppointment: null,
      needsRebook: false
    };
  }

  const lastPastAppointment = [...appointments].reverse().find((appointment) => {
    const appointmentDate = appointment.appointment_date;
    return typeof appointmentDate === "string" && appointmentDate <= nowIso;
  });

  if (!lastPastAppointment || typeof lastPastAppointment.appointment_date !== "string") {
    return {
      lastQualifyingPastAppointment: null,
      needsRebook: false
    };
  }

  const lastAppointmentLocalDate = getLocalDateForInstant(lastPastAppointment.appointment_date, timeZone);
  const needsRebook =
    lastAppointmentLocalDate >= rebookWindowStartDate && lastAppointmentLocalDate <= rebookWindowEndDate;

  return {
    lastQualifyingPastAppointment: needsRebook ? lastPastAppointment : null,
    needsRebook
  };
};
