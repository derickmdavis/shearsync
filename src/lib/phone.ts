const US_COUNTRY_CODE = "1";

const stripToDigitsAndPlus = (value: string): string => value.replace(/[^\d+]/g, "");

const ensureSingleLeadingPlus = (value: string): string | null => {
  const plusCount = [...value].filter((char) => char === "+").length;
  if (plusCount > 1) {
    return null;
  }

  if (plusCount === 1 && !value.startsWith("+")) {
    return null;
  }

  return value;
};

export const normalizePhone = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const cleaned = ensureSingleLeadingPlus(stripToDigitsAndPlus(trimmed));
  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      return null;
    }

    return `+${digits}`;
  }

  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+${US_COUNTRY_CODE}${digits}`;
  }

  if (digits.length === 11 && digits.startsWith(US_COUNTRY_CODE)) {
    return `+${digits}`;
  }

  return null;
};

export const maskPhone = (value: string): string => {
  const digits = value.replace(/\D/g, "");
  const lastFour = digits.slice(-4);

  return lastFour ? `***-***-${lastFour}` : "***-***-****";
};
