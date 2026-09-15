export const onboardingDays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type OnboardingDraft = {
  name: string;
  phone: string;
  email: string;
  address: string;
  hours: Record<
    string,
    {
      open: string;
      close: string;
      closed: boolean;
    }
  >;
  services: {
    name: string;
    duration: string;
    price: string;
    description: string;
  }[];
  receptionist: string;
  greeting: string;
};

export function newOnboardingDraft(): OnboardingDraft {
  return {
    name: '',
    phone: '',
    email: '',
    address: '',
    hours: Object.fromEntries(
      onboardingDays.map((day) => [
        day,
        {
          open: '09:00',
          close: '17:00',
          closed: day === 'sunday',
        },
      ])
    ),
    services: [
      {
        name: '',
        duration: '30',
        price: '',
        description: '',
      },
    ],
    receptionist: 'Ana',
    greeting: 'Hello! How can I help you today?',
  };
}

export function isOnboardingDraft(
  value: unknown
): value is OnboardingDraft {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const draft = value as OnboardingDraft;

  return (
    [
      'name',
      'phone',
      'email',
      'address',
      'receptionist',
      'greeting',
    ].every(
      (key) =>
        typeof draft[key as keyof OnboardingDraft] === 'string'
    ) &&
    onboardingDays.every(
      (day) =>
        typeof draft.hours?.[day]?.closed === 'boolean' &&
        typeof draft.hours[day].open === 'string' &&
        typeof draft.hours[day].close === 'string'
    ) &&
    Array.isArray(draft.services) &&
    draft.services.length > 0 &&
    draft.services.length <= 50 &&
    draft.services.every(
      (service) =>
        service &&
        ['name', 'duration', 'price', 'description'].every(
          (key) =>
            typeof service[key as keyof typeof service] === 'string'
        )
    )
  );
}

export function validateOnboarding(value: OnboardingDraft) {
  if (!isOnboardingDraft(value)) {
    throw Error('Check your setup details.');
  }

  const name = value.name.trim();
  const phone = value.phone.trim();
  const email = value.email.trim();
  const address = value.address.trim();

  if (!name || name.length > 200) {
    throw Error('Enter a business name (up to 200 characters).');
  }

  if (!phone) {
    throw Error('Enter your business phone number.');
  }

  if (phone.length > 30 || !/^[+\d\s().-]{7,30}$/.test(phone)) {
    throw Error('Enter a valid business phone number.');
  }

  if (!email) {
    throw Error('Enter your business email address.');
  }

  if (
    email.length > 2000 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw Error('Enter a valid business email address.');
  }

  if (!address) {
    throw Error('Enter your business address.');
  }

  if (address.length > 2000) {
    throw Error('Enter a business address up to 2000 characters.');
  }

  if (
    typeof value.receptionist !== 'string' ||
    value.receptionist.length > 2000 ||
    typeof value.greeting !== 'string' ||
    value.greeting.length > 2000
  ) {
    throw Error('Check your receptionist details.');
  }

  for (const day of onboardingDays) {
    const hours = value.hours?.[day];

    if (
      !hours ||
      typeof hours.closed !== 'boolean' ||
      (!hours.closed &&
        (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.open) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.close) ||
          hours.close <= hours.open))
    ) {
      throw Error(
        'Check opening and closing hours for every day.'
      );
    }
  }

  if (
    !Array.isArray(value.services) ||
    !value.services.length ||
    value.services.length > 50
  ) {
    throw Error('Add between 1 and 50 services.');
  }

  for (const service of value.services) {
    if (
      !service ||
      typeof service.name !== 'string' ||
      !service.name.trim() ||
      service.name.length > 200 ||
      typeof service.description !== 'string' ||
      service.description.length > 2000 ||
      typeof service.duration !== 'string' ||
      !/^\d+$/.test(service.duration) ||
      Number(service.duration) < 1 ||
      Number(service.duration) > 1440 ||
      typeof service.price !== 'string' ||
      (service.price !== '' &&
        (!/^\d+(\.\d{1,2})?$/.test(service.price) ||
          !Number.isFinite(Number(service.price))))
    ) {
      throw Error(
        'Each service needs a name, duration of 1–1440 minutes, and a valid optional price.'
      );
    }
  }

  if (!value.receptionist.trim() || !value.greeting.trim()) {
    throw Error('Enter a receptionist name and greeting.');
  }

  return value;
}