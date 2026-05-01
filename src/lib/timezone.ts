import type { Row } from "../services/db";

export const defaultBusinessTimeZone = "UTC";

export const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const resolveBusinessTimeZone = (user: Row | null | undefined): string => {
  const value = user?.timezone;
  return typeof value === "string" && isValidTimeZone(value) ? value : defaultBusinessTimeZone;
};

const parseDateText = (dateText: string): { year: number; month: number; day: number } => {
  const [yearText, monthText, dayText] = dateText.split("-");

  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText)
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");

const formatOffset = (offsetMinutes: number): string => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
};

export const addDays = (dateText: string, days: number): string => {
  const { year, month, day } = parseDateText(dateText);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);

  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
};

export const formatDateInTimeZone = (
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): string => new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(date);

const getDatePartsInTimeZone = (date: Date, timeZone: string): Record<string, string> => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return parts.reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }

    return result;
  }, {});
};

const getOffsetMinutes = (date: Date, timeZone: string): number => {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const offset = formatted.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(offset);

  if (!match?.groups?.sign) {
    return 0;
  }

  const hours = Number(match.groups.hours ?? "0");
  const minutes = Number(match.groups.minutes ?? "0");
  const direction = match.groups.sign === "+" ? 1 : -1;

  return direction * (hours * 60 + minutes);
};

export const getTimeZoneOffsetStringForInstant = (instant: Date | string, timeZone: string): string =>
  formatOffset(getOffsetMinutes(typeof instant === "string" ? new Date(instant) : instant, timeZone));

export const zonedDateTimeToUtc = (
  dateText: string,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
): Date => {
  const { year, month, day } = parseDateText(dateText);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const initialOffsetMinutes = getOffsetMinutes(new Date(utcGuess), timeZone);
  const adjustedUtc = utcGuess - initialOffsetMinutes * 60_000;
  const adjustedOffsetMinutes = getOffsetMinutes(new Date(adjustedUtc), timeZone);

  if (adjustedOffsetMinutes === initialOffsetMinutes) {
    return new Date(adjustedUtc);
  }

  return new Date(utcGuess - adjustedOffsetMinutes * 60_000);
};

export const getCurrentLocalDate = (timeZone: string, now = new Date()): string => {
  const parts = getDatePartsInTimeZone(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const getLocalDateForInstant = (instant: string, timeZone: string): string => {
  const parts = getDatePartsInTimeZone(new Date(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const getStartOfLocalDayUtc = (dateText: string, timeZone: string): Date =>
  zonedDateTimeToUtc(dateText, timeZone, 0, 0, 0, 0);

export const getEndOfLocalDayUtc = (dateText: string, timeZone: string): Date =>
  zonedDateTimeToUtc(addDays(dateText, 1), timeZone, 0, 0, 0, 0);

export const getStartOfCurrentLocalMonthUtc = (timeZone: string, now = new Date()): Date => {
  const parts = getDatePartsInTimeZone(now, timeZone);
  return zonedDateTimeToUtc(`${parts.year}-${parts.month}-01`, timeZone, 0, 0, 0, 0);
};

export const getLocalDayOfWeekForDate = (dateText: string, timeZone: string): number => {
  const weekday = formatDateInTimeZone(zonedDateTimeToUtc(dateText, timeZone, 12, 0, 0, 0), timeZone, {
    weekday: "short"
  });

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
};

export const getLocalDayOfWeekForInstant = (instant: string, timeZone: string): number => {
  const weekday = formatDateInTimeZone(new Date(instant), timeZone, {
    weekday: "short"
  });

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
};

export const getMinutesSinceMidnightForInstant = (instant: string, timeZone: string): number => {
  const parts = getDatePartsInTimeZone(new Date(instant), timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
};

export const formatInstantInTimeZoneOffset = (instant: Date | string, timeZone: string): string => {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${getTimeZoneOffsetStringForInstant(date, timeZone)}`;
};
