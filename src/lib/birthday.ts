const birthdayPattern = /^(\d{2})\/(\d{2})$/;

const pad = (value: number): string => String(value).padStart(2, "0");

export type BirthdayParts = {
  day: number;
  month: number;
};

export const parseBirthday = (birthday: string): BirthdayParts | null => {
  const match = birthdayPattern.exec(birthday);
  if (!match) {
    return null;
  }

  const [, dayText, monthText] = match;
  const day = Number(dayText);
  const month = Number(monthText);

  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1) {
    return null;
  }

  const lastDayOfMonth = new Date(Date.UTC(2024, month, 0)).getUTCDate();
  if (day > lastDayOfMonth) {
    return null;
  }

  return { day, month };
};

export const isValidBirthday = (birthday: string): boolean => parseBirthday(birthday) !== null;

export const normalizeBirthday = (value: unknown): string | null =>
  typeof value === "string" && isValidBirthday(value) ? value : null;

export const toBirthdayOccurrence = (birthday: string, year: number): string | null => {
  const parts = parseBirthday(birthday);
  if (!parts || !Number.isFinite(year)) {
    return null;
  }

  const lastDayOfMonth = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDayOfMonth);

  return `${year}-${pad(parts.month)}-${pad(day)}`;
};
