import {
  businessDayKeys,
  type BusinessHours,
  validateBusinessHours,
} from "@/lib/business-hours";

export const onboardingDays = businessDayKeys;

export type OnboardingDraft = {
  name: string;
  phone: string;
  email: string;
  address: string;
  timezone: string;
  hours: BusinessHours;
  services: {
    name: string;
    duration: string;
    price: string;
    description: string;
  }[];
  receptionist: string;
  greeting: string;
};

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format();

    return true;
  } catch {
    return false;
  }
}

export function newOnboardingDraft(): OnboardingDraft {
  return {
    name: "",
    phone: "",
    email: "",
    address: "",
    timezone: "America/Los_Angeles",
    hours: {
      monday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      tuesday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      wednesday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      thursday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      friday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      saturday: {
        open: "09:00",
        close: "17:00",
        closed: false,
      },
      sunday: {
        open: "",
        close: "",
        closed: true,
      },
    },
    services: [
      {
        name: "",
        duration: "30",
        price: "",
        description: "",
      },
    ],
    receptionist: "Ana",
    greeting: "Hello! How can I help you today?",
  };
}

export function isOnboardingDraft(
  value: unknown
): value is OnboardingDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const draft = value as OnboardingDraft;

  return (
    [
      "name",
      "phone",
      "email",
      "address",
      "timezone",
      "receptionist",
      "greeting",
    ].every(
      (key) =>
        typeof draft[key as keyof OnboardingDraft] === "string"
    ) &&
    onboardingDays.every(
      (day) =>
        typeof draft.hours?.[day]?.closed === "boolean" &&
        typeof draft.hours[day].open === "string" &&
        typeof draft.hours[day].close === "string"
    ) &&
    Array.isArray(draft.services) &&
    draft.services.length > 0 &&
    draft.services.length <= 50 &&
    draft.services.every(
      (service) =>
        service &&
        ["name", "duration", "price", "description"].every(
          (key) =>
            typeof service[key as keyof typeof service] === "string"
        )
    )
  );
}

export function validateOnboarding(value: OnboardingDraft) {
  if (!isOnboardingDraft(value)) {
    throw Error("Check your setup details.");
  }

  const name = value.name.trim();
  const phone = value.phone.trim();
  const email = value.email.trim();
  const address = value.address.trim();
  const timezone = value.timezone.trim();

  if (!name || name.length > 200) {
    throw Error("Enter a business name (up to 200 characters).");
  }

  if (!phone) {
    throw Error("Enter your business phone number.");
  }

  if (phone.length > 30 || !/^[+\d\s().-]{7,30}$/.test(phone)) {
    throw Error("Enter a valid business phone number.");
  }

  if (!email) {
    throw Error("Enter your business email address.");
  }

  if (
    email.length > 2000 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw Error("Enter a valid business email address.");
  }

  if (!address) {
    throw Error("Enter your business address.");
  }

  if (address.length > 2000) {
    throw Error("Enter a business address up to 2000 characters.");
  }

  if (
    !timezone ||
    timezone.length > 200 ||
    !isValidTimeZone(timezone)
  ) {
    throw Error("Choose a valid business timezone.");
  }

  if (
    typeof value.receptionist !== "string" ||
    value.receptionist.length > 2000 ||
    typeof value.greeting !== "string" ||
    value.greeting.length > 2000
  ) {
    throw Error("Check your receptionist details.");
  }

  const hoursValidation = validateBusinessHours(value.hours);

  if (!hoursValidation.success) {
    throw Error(hoursValidation.error);
  }

  if (
    !Array.isArray(value.services) ||
    !value.services.length ||
    value.services.length > 50
  ) {
    throw Error("Add between 1 and 50 services.");
  }

  for (const service of value.services) {
    if (
      !service ||
      typeof service.name !== "string" ||
      !service.name.trim() ||
      service.name.length > 200 ||
      typeof service.description !== "string" ||
      service.description.length > 2000 ||
      typeof service.duration !== "string" ||
      !/^\d+$/.test(service.duration) ||
      Number(service.duration) < 1 ||
      Number(service.duration) > 1440 ||
      typeof service.price !== "string" ||
      (service.price !== "" &&
        (!/^\d+(\.\d{1,2})?$/.test(service.price) ||
          !Number.isFinite(Number(service.price))))
    ) {
      throw Error(
        "Each service needs a name, duration of 1–1440 minutes, and a valid optional price."
      );
    }
  }

  if (!value.receptionist.trim() || !value.greeting.trim()) {
    throw Error("Enter a receptionist name and greeting.");
  }

  return {
    ...value,
    name,
    phone,
    email,
    address,
    timezone,
    hours: hoursValidation.hours,
    receptionist: value.receptionist.trim(),
    greeting: value.greeting.trim(),
  };
}