export const businessDayKeys = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type DayKey = (typeof businessDayKeys)[number];

export type DayHours = {
  open: string;
  close: string;
  closed: boolean;
};

export type BusinessHours = Record<DayKey, DayHours>;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createDefaultBusinessHours(): BusinessHours {
  return {
    monday: {
      open: "09:00",
      close: "18:00",
      closed: false,
    },
    tuesday: {
      open: "09:00",
      close: "18:00",
      closed: false,
    },
    wednesday: {
      open: "09:00",
      close: "18:00",
      closed: false,
    },
    thursday: {
      open: "09:00",
      close: "18:00",
      closed: false,
    },
    friday: {
      open: "09:00",
      close: "18:00",
      closed: false,
    },
    saturday: {
      open: "10:00",
      close: "16:00",
      closed: false,
    },
    sunday: {
      open: "",
      close: "",
      closed: true,
    },
  };
}

export function normalizeBusinessHours(
  value: unknown
): BusinessHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const result = {} as BusinessHours;

  for (const day of businessDayKeys) {
    const rawDay = source[day];

    if (
      !rawDay ||
      typeof rawDay !== "object" ||
      Array.isArray(rawDay)
    ) {
      return null;
    }

    const hours = rawDay as Record<string, unknown>;

    if (
      typeof hours.closed !== "boolean" ||
      typeof hours.open !== "string" ||
      typeof hours.close !== "string"
    ) {
      return null;
    }

    if (hours.closed) {
      result[day] = {
        open: "",
        close: "",
        closed: true,
      };

      continue;
    }

    if (
      !TIME_PATTERN.test(hours.open) ||
      !TIME_PATTERN.test(hours.close) ||
      hours.close <= hours.open
    ) {
      return null;
    }

    result[day] = {
      open: hours.open,
      close: hours.close,
      closed: false,
    };
  }

  return result;
}

export function parseBusinessHours(
  value: string | null
): BusinessHours | null {
  if (!value) {
    return null;
  }

  try {
    return normalizeBusinessHours(JSON.parse(value));
  } catch {
    return null;
  }
}

export function validateBusinessHours(
  value: BusinessHours
):
  | { success: true; hours: BusinessHours }
  | { success: false; error: string } {
  const normalized = normalizeBusinessHours(value);

  if (!normalized) {
    return {
      success: false,
      error:
        "Check opening and closing hours for every day.",
    };
  }

  return {
    success: true,
    hours: normalized,
  };
}