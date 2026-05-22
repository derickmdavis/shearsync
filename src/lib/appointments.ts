export const getAppointmentEndIso = (appointmentDate: string, durationMinutes: number): string =>
  new Date(new Date(appointmentDate).getTime() + durationMinutes * 60_000).toISOString();

export const appointmentsOverlap = (
  appointmentDate: string,
  durationMinutes: number,
  existingDate: string,
  existingDurationMinutes: number
): boolean => {
  const appointmentStart = new Date(appointmentDate).getTime();
  const appointmentEnd = appointmentStart + durationMinutes * 60_000;
  const existingStart = new Date(existingDate).getTime();
  const existingEnd = existingStart + existingDurationMinutes * 60_000;

  return Number.isFinite(appointmentStart)
    && Number.isFinite(appointmentEnd)
    && Number.isFinite(existingStart)
    && Number.isFinite(existingEnd)
    && appointmentStart < existingEnd
    && appointmentEnd > existingStart;
};
