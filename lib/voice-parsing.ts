import {
  validDate,
  uniqueService,
} from "./ai-actions";

export function normalizedSpeech(
  value: string
): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function confirmation(
  value: string
):
  | "yes"
  | "no"
  | "ambiguous" {
  const text =
    normalizedSpeech(value);

  if (
    /^(yes|yeah|yep|correct|confirm|that's correct|that is correct|that's right|that is right|looks good|sounds good|book it|please book it|yes please)$/.test(
      text
    )
  ) {
    return "yes";
  }

  if (
    /^(no|nope|cancel|stop|never mind|nevermind|go back|start over|don't book it|do not book it|that's wrong|that is wrong|no thanks|goodbye|bye)$/.test(
      text
    )
  ) {
    return "no";
  }

  return "ambiguous";
}

const numbers: Record<
  string,
  number
> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

function number(
  text: string
): number | null {
  if (/^\d{1,2}$/.test(text)) {
    return Number(text);
  }

  if (
    Object.hasOwn(
      numbers,
      text
    )
  ) {
    return numbers[text];
  }

  const parts =
    text.split(" ");

  if (
    parts.length === 2 &&
    [
      "twenty",
      "thirty",
      "forty",
      "fifty",
    ].includes(parts[0]) &&
    numbers[parts[1]] >= 1 &&
    numbers[parts[1]] <= 9
  ) {
    return (
      numbers[parts[0]] +
      numbers[parts[1]]
    );
  }

  if (
    parts.length === 2 &&
    ["oh", "zero"].includes(
      parts[0]
    ) &&
    numbers[parts[1]] >= 1 &&
    numbers[parts[1]] < 10
  ) {
    return numbers[parts[1]];
  }

  return null;
}

export type TimeInterpretation =
  | {
      kind: "valid";
      value: string;
    }
  | {
      kind: "ambiguous";
      options: [
        string,
        string,
      ];
    }
  | {
      kind: "invalid";
    };

export function parseSpokenTime(
  input: string
): TimeInterpretation {
  let text =
    normalizedSpeech(input)
      .replace(
        /([ap])\s+m\b/g,
        "$1m"
      )
      .replace(
        /^(?:at|around|about) /,
        ""
      )
      .replace(
        / please$/,
        ""
      )
      .replace(
        /o\s*'?clock/g,
        ""
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    [
      "noon",
      "12 noon",
      "midday",
    ].includes(text)
  ) {
    return {
      kind: "valid",
      value: "12:00",
    };
  }

  if (
    text === "midnight" ||
    text === "12 midnight"
  ) {
    return {
      kind: "valid",
      value: "00:00",
    };
  }

  let period:
    | "am"
    | "pm"
    | undefined;

  /*
   * Twilio speech recognition can omit the article
   * "the" in phrases such as:
   *
   *   "2:30 in the afternoon"
   *   "2:30 in afternoon"
   *
   * Both are explicit period-of-day statements.
   * This remains deterministic and does not infer
   * AM/PM from a bare time.
   */
  const suffix =
    /\s*(am|pm|in (?:the )?morning|in (?:the )?afternoon|in (?:the )?evening|at night)$/.exec(
      text
    );

  if (suffix) {
    period = [
      "am",
      "in the morning",
      "in morning",
    ].includes(suffix[1])
      ? "am"
      : "pm";

    text = text
      .slice(
        0,
        suffix.index
      )
      .trim();
  }

  let hour:
    | number
    | null = null;

  let minute = 0;

  const digital =
    /^(\d{1,2}):([0-9]{2})$/.exec(
      text
    );

  if (digital) {
    hour =
      Number(digital[1]);

    minute =
      Number(digital[2]);
  } else {
    const relative =
      /^(half past|quarter past) (.+)$/.exec(
        text
      );

    if (relative) {
      hour =
        number(relative[2]);

      minute =
        relative[1] ===
        "half past"
          ? 30
          : 15;
    } else {
      hour = number(text);

      if (hour === null) {
        const parts =
          text.split(" ");

        hour =
          number(parts[0]);

        const parsedMinute =
          number(
            parts
              .slice(1)
              .join(" ")
          );

        if (
          parsedMinute === null
        ) {
          return {
            kind: "invalid",
          };
        }

        minute =
          parsedMinute;
      }
    }
  }

  if (
    hour === null ||
    minute > 59 ||
    minute < 0 ||
    hour < 0 ||
    hour > 23 ||
    (period &&
      (hour < 1 ||
        hour > 12))
  ) {
    return {
      kind: "invalid",
    };
  }

  const canonical = (
    value: number
  ) =>
    `${String(value).padStart(
      2,
      "0"
    )}:${String(
      minute
    ).padStart(2, "0")}`;

  if (period) {
    return {
      kind: "valid",
      value: canonical(
        (hour % 12) +
          (period === "pm"
            ? 12
            : 0)
      ),
    };
  }

  /*
   * A zero-padded colon time is explicit
   * 24-hour notation; bare words are not.
   */
  if (
    digital &&
    digital[1].length === 2
  ) {
    return {
      kind: "valid",
      value:
        canonical(hour),
    };
  }

  if (
    hour < 1 ||
    hour > 12
  ) {
    return {
      kind: "invalid",
    };
  }

  return {
    kind: "ambiguous",
    options: [
      canonical(hour % 12),
      canonical(
        (hour % 12) + 12
      ),
    ],
  };
}

export function businessLocalDate(
  timezone: string | null,
  offsetDays = 0,
  now = Date.now()
): string | null {
  if (!timezone) {
    return null;
  }

  try {
    const parts =
      Object.fromEntries(
        new Intl.DateTimeFormat(
          "en-CA",
          {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }
        )
          .formatToParts(
            new Date(now)
          )
          .map((part) => [
            part.type,
            part.value,
          ])
      );

    /*
     * Calendar-day arithmetic AFTER timezone
     * conversion avoids DST +/-24h errors.
     */
    const day = new Date(
      `${parts.year}-${parts.month}-${parts.day}T00:00:00Z`
    );

    day.setUTCDate(
      day.getUTCDate() +
        offsetDays
    );

    return day
      .toISOString()
      .slice(0, 10);
  } catch {
    return null;
  }
}

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const ordinals = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "twenty first",
  "twenty second",
  "twenty third",
  "twenty fourth",
  "twenty fifth",
  "twenty sixth",
  "twenty seventh",
  "twenty eighth",
  "twenty ninth",
  "thirtieth",
  "thirty first",
];

export function bookingDate(
  input: string,
  timezone: string | null,
  now = Date.now()
): string | null {
  let text =
    normalizedSpeech(input)
      .replace(
        /^(?:on|for) /,
        ""
      )
      .replace(
        / please$/,
        ""
      );

  const today =
    businessLocalDate(
      timezone,
      0,
      now
    );

  if (
    text === "today" ||
    text === "tomorrow"
  ) {
    return businessLocalDate(
      timezone,
      text === "tomorrow"
        ? 1
        : 0,
      now
    );
  }

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      text
    )
  ) {
    return (
      !text.startsWith(
        "0000"
      ) &&
      validDate(text)
    )
      ? text
      : null;
  }

  const weekday =
    /^(?:(this|next) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(
      text
    );

  if (
    weekday &&
    today
  ) {
    const current =
      new Date(
        `${today}T00:00:00Z`
      ).getUTCDay();

    const desired = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ].indexOf(
      weekday[2]
    );

    /*
     * "this" = current calendar week;
     * "next" = following calendar week
     * (Monday start).
     *
     * A BARE weekday ("Friday") is the next occurrence on or
     * after today. Unlike the calendar-week forms it can never
     * resolve into the past, so a caller who simply says a day
     * name is not rejected for naming a past date.
     */
    const delta =
      weekday[1]
        ? ((desired + 6) % 7) -
          ((current + 6) % 7) +
          (weekday[1] === "next"
            ? 7
            : 0)
        : (desired -
            current +
            7) %
          7;

    return businessLocalDate(
      timezone,
      delta,
      now
    );
  }

  text =
    text.replace(
      /-/g,
      " "
    );

  for (
    const ordinal of [
      ...ordinals,
    ].sort(
      (a, b) =>
        b.length -
        a.length
    )
  ) {
    text = text.replace(
      new RegExp(
        `\\b${ordinal}\\b`,
        "g"
      ),
      String(
        ordinals.indexOf(
          ordinal
        ) + 1
      )
    );
  }

  text = text.replace(
    /(\d)(st|nd|rd|th)\b/g,
    "$1"
  );

  const names =
    months.join("|");

  const yearFirst =
    new RegExp(
      `^(\\d{4}) (${names}) (\\d{1,2})$`
    ).exec(text);

  const monthFirst =
    new RegExp(
      `^(${names}) (\\d{1,2})(?: (\\d{4}))?$`
    ).exec(text);

  const dayFirst =
    new RegExp(
      `^(?:the )?(\\d{1,2}) of (${names})(?: (\\d{4}))?$`
    ).exec(text);

  if (
    !yearFirst &&
    !monthFirst &&
    !dayFirst
  ) {
    return null;
  }

  const year =
    yearFirst?.[1] ||
    monthFirst?.[3] ||
    dayFirst?.[3];

  const month =
    months.indexOf(
      yearFirst?.[2] ||
        monthFirst?.[1] ||
        dayFirst![2]
    ) + 1;

  const day =
    Number(
      yearFirst?.[3] ||
        monthFirst?.[2] ||
        dayFirst![1]
    );

  const canonical = (
    value: number
  ) =>
    `${String(
      value
    ).padStart(
      4,
      "0"
    )}-${String(
      month
    ).padStart(
      2,
      "0"
    )}-${String(
      day
    ).padStart(
      2,
      "0"
    )}`;

  if (year) {
    const result =
      canonical(
        Number(year)
      );

    return (
      Number(year) > 0 &&
      validDate(result)
    )
      ? result
      : null;
  }

  if (!today) {
    return null;
  }

  const candidate =
    canonical(
      Number(
        today.slice(0, 4)
      )
    );

  const result =
    validDate(candidate) &&
    candidate >= today
      ? candidate
      : canonical(
          Number(
            today.slice(
              0,
              4
            )
          ) + 1
        );

  return validDate(result)
    ? result
    : null;
}

function serviceKey(
  value: string
): string {
  return normalizedSpeech(
    value
  )
    .replace(
      /\b[a-z]{4,}s\b/g,
      (word) =>
        /(?:ss|us|is)$/.test(
          word
        )
          ? word
          : word.slice(0, -1)
    )
    .replace(
      /[^\p{L}\p{N}]/gu,
      ""
    );
}

export function matchVoiceService<
  T extends {
    name: string;
  },
>(
  services: T[],
  speech: string
): {
  match: T | null;
  candidates: T[];
} {
  if (
    !speech.trim() ||
    speech.length > 200
  ) {
    return {
      match: null,
      candidates: [],
    };
  }

  const strict =
    uniqueService(
      services,
      speech
    );

  if (strict) {
    return {
      match: strict,
      candidates: [strict],
    };
  }

  const stripped =
    normalizedSpeech(speech)
      .replace(
        /^(?:(?:i'd like|i would like|i want)(?: to book)?|can i get|could i get|can i have|could i book) /,
        ""
      )
      .replace(
        /^(?:a|an|the) /,
        ""
      )
      .replace(
        / please$/,
        ""
      );

  const key =
    serviceKey(stripped);

  if (!key) {
    return {
      match: null,
      candidates: [],
    };
  }

  const exact =
    services.filter(
      (service) =>
        serviceKey(
          service.name
        ) === key
    );

  if (exact.length) {
    return {
      match:
        exact.length === 1
          ? exact[0]
          : null,
      candidates: exact,
    };
  }

  const candidates =
    services.filter(
      (service) =>
        serviceKey(
          service.name
        ).includes(key)
    );

  return {
    match:
      candidates.length === 1
        ? candidates[0]
        : null,
    candidates,
  };
}