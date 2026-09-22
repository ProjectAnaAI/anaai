import "server-only";

import {
  bookingDate,
  normalizedSpeech,
  parseSpokenTime,
  type TimeInterpretation,
} from "@/lib/voice-parsing";

/*
 * Deterministic booking-slot extraction.
 *
 * The deployed matcher only ever tested a WHOLE utterance against a service
 * name, so "Facial on October 2nd at 2:30 in the afternoon" could not match
 * "Facial". This module instead scans the utterance for each detail and
 * consumes the span it used, so one sentence can contribute several fields in
 * any order.
 *
 * It reuses the existing strict whole-string parsers (parseSpokenTime,
 * bookingDate) on candidate spans rather than loosening them. Those parsers
 * stay strict: "random 1 PM" is still not a time, and "September 24 or 25" is
 * still not a date. Only the SELECTION of what to hand them is new.
 *
 * Nothing here is authority. It proposes values; validation, availability and
 * booking remain with the database.
 */

export type SlotService = {
  id: string;
  name: string;
};

export type BookingDetails = {
  /* Exactly one service was named. */
  service: SlotService | null;
  /* Every distinct service named, for focused disambiguation. */
  serviceCandidates: SlotService[];
  /* A date phrase was present and resolved to a business-local calendar day. */
  date: string | null;
  /* A date phrase was present but did not resolve. */
  dateUnresolved: boolean;
  /* A time phrase was present; kind distinguishes valid/ambiguous. */
  time: TimeInterpretation | null;
  /* A conservative customer-name reading of the remaining words. */
  name: string | null;
  /* Any field at all was recognised. */
  any: boolean;
};

type Token = {
  norm: string;
  start: number;
  end: number;
};

/* Longest phrase any single extractor will consider, in tokens. */
const MAX_WINDOW = 7;

const MAX_SPEECH = 500;

/*
 * Words that can never begin or end a customer name. Without this the residue
 * of "I want to book an appointment for tomorrow" would be offered as a name.
 */
const NAME_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "at", "on", "in", "for", "to", "of", "with",
  "please", "thanks", "thank", "you", "i", "id", "i'd", "im", "i'm", "it",
  "it's", "its", "is", "am", "are", "was", "we", "my", "me", "name", "names",
  "called", "under", "this", "that", "would", "like", "want", "wanna", "need",
  "can", "could", "get", "got", "have", "book", "booking", "booked", "reserve",
  "reservation", "schedule", "scheduled", "appointment", "appointments",
  "make", "put", "set", "up", "hi", "hello", "hey", "yes", "yeah", "no",
  "okay", "ok", "so", "just", "actually", "instead", "change", "make it",
  "sorry", "um", "uh", "well", "let", "lets", "let's", "do", "does", "please",
]);

/*
 * Explicit name introductions. Anything after one of these, up to a clause
 * break, is a much stronger name signal than leftover words.
 */
const NAME_INTRODUCTION =
  /\b(?:(?:the |my )?name(?:'s| is)?(?: for (?:the )?appointment)?(?: is)?|it(?:'s| is) for|this is|i'?m|i am|under|for)\s+(.+)$/i;

function tokenize(speech: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}:'’-]*/gu;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(speech)) !== null) {
    const norm = normalizedSpeech(match[0]);

    if (norm) {
      tokens.push({
        norm,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return tokens;
}

function phrase(tokens: Token[], from: number, to: number): string {
  return tokens
    .slice(from, to + 1)
    .map((token) => token.norm)
    .join(" ");
}

/*
 * Longest-leftmost scan. `read` returns a value for a candidate phrase or null.
 * Consumed token positions are removed from `open` so a later extractor cannot
 * reinterpret them -- this is what stops the "2" of "October 2nd" from also
 * being read as a bare hour.
 */
function scan<T>(
  tokens: Token[],
  open: boolean[],
  read: (text: string) => T | null
): { value: T; from: number; to: number } | null {
  for (let from = 0; from < tokens.length; from += 1) {
    if (!open[from]) {
      continue;
    }

    const limit = Math.min(from + MAX_WINDOW - 1, tokens.length - 1);

    for (let to = limit; to >= from; to -= 1) {
      let usable = true;

      for (let index = from; index <= to; index += 1) {
        if (!open[index]) {
          usable = false;
          break;
        }
      }

      if (!usable) {
        continue;
      }

      const value = read(phrase(tokens, from, to));

      if (value !== null) {
        return { value, from, to };
      }
    }
  }

  return null;
}

function consume(open: boolean[], from: number, to: number) {
  for (let index = from; index <= to; index += 1) {
    open[index] = false;
  }
}

/*
 * "September 24 or 25" and "one or two PM" offer a choice. Scanning would
 * otherwise silently take the first option. Treat a trailing alternative as
 * genuine ambiguity so the caller is asked instead.
 */
function offersAlternative(tokens: Token[], to: number): boolean {
  const next = tokens[to + 1];
  return Boolean(next && (next.norm === "or" || next.norm === "either"));
}

/*
 * Service comparison key. Mirrors the deployed matcher's normalization
 * (case, punctuation and a conservative plural fold) so a service that matched
 * before still matches.
 */
function serviceKey(value: string): string {
  return normalizedSpeech(value)
    .replace(/\b[a-z]{4,}s\b/g, (word) =>
      /(?:ss|us|is)$/.test(word) ? word : word.slice(0, -1)
    )
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function readName(text: string): string | null {
  const words = text.split(" ").filter(Boolean);

  if (!words.length || words.length > 5) {
    return null;
  }

  if (words.some((word) => NAME_STOPWORDS.has(word) || /\d/.test(word))) {
    return null;
  }

  return words.join(" ");
}

/*
 * Recover the caller's original casing for a span, so "BJ" is not spoken back
 * as "bj". Falls back to the normalized text when the slice looks unusable.
 */
function original(
  speech: string,
  tokens: Token[],
  from: number,
  to: number
): string {
  const slice = speech
    .slice(tokens[from].start, tokens[to].end)
    .replace(/\s+/g, " ")
    .trim();

  return slice && !/[<>\u0000-\u001f]/.test(slice)
    ? slice
    : phrase(tokens, from, to);
}

export function extractBookingDetails({
  speech,
  services,
  timezone,
  now = Date.now(),
  wantName = false,
}: {
  speech: string;
  services: SlotService[];
  timezone: string | null;
  now?: number;
  wantName?: boolean;
}): BookingDetails {
  const empty: BookingDetails = {
    service: null,
    serviceCandidates: [],
    date: null,
    dateUnresolved: false,
    time: null,
    name: null,
    any: false,
  };

  if (!speech || speech.length > MAX_SPEECH) {
    return empty;
  }

  const tokens = tokenize(speech);

  if (!tokens.length) {
    return empty;
  }

  const open = tokens.map(() => true);

  /*
   * SERVICE first: service names are the most distinctive tokens, and a
   * service such as "30 minute touch up" must not have its digits eaten by the
   * time scanner. Every distinct service named is collected so an utterance
   * naming two services asks instead of guessing.
   */
  const byKey = new Map<string, SlotService[]>();

  for (const service of services) {
    const key = serviceKey(service.name);

    if (!key) {
      continue;
    }

    byKey.set(key, [...(byKey.get(key) || []), service]);
  }

  const found = new Map<string, SlotService>();
  let ambiguousService = false;

  for (;;) {
    const hit = scan(tokens, open, (text) => {
      const matches = byKey.get(serviceKey(text));
      return matches && matches.length ? matches : null;
    });

    if (!hit) {
      break;
    }

    consume(open, hit.from, hit.to);

    if (hit.value.length > 1) {
      /* Two active services share a name; never pick one silently. */
      ambiguousService = true;

      for (const service of hit.value) {
        found.set(service.id, service);
      }
    } else {
      found.set(hit.value[0].id, hit.value[0]);
    }
  }

  /*
   * No exact name matched. Fall back to a WHOLE sub-phrase of a service name:
   * "haircut" matches "Haircut basic" and "Haircut premium", which is a
   * disambiguation question rather than a silent pick.
   *
   * Deliberately NOT a substring test. "something for my hair" must not book a
   * "Haircut" off the letters "hair"; guessing a service is worse than asking.
   */
  if (!found.size) {
    const subPhrases = new Map<string, SlotService[]>();

    for (const service of services) {
      const words = normalizedSpeech(service.name)
        .split(" ")
        .filter(Boolean);

      for (let from = 0; from < words.length; from += 1) {
        for (let to = from; to < words.length; to += 1) {
          const key = serviceKey(words.slice(from, to + 1).join(" "));

          if (key.length < 3) {
            continue;
          }

          const existing = subPhrases.get(key) || [];

          if (!existing.some((item) => item.id === service.id)) {
            subPhrases.set(key, [...existing, service]);
          }
        }
      }
    }

    const partial = scan(tokens, open, (text) => {
      const matches = subPhrases.get(serviceKey(text));
      return matches && matches.length ? matches : null;
    });

    if (partial) {
      consume(open, partial.from, partial.to);

      if (partial.value.length > 1) {
        ambiguousService = true;
      }

      for (const item of partial.value) {
        found.set(item.id, item);
      }
    }
  }

  const serviceCandidates = [...found.values()];

  const service =
    serviceCandidates.length === 1 && !ambiguousService
      ? serviceCandidates[0]
      : null;

  /*
   * DATE next. bookingDate requires a month name, weekday, ISO date or
   * today/tomorrow, so it cannot claim a bare number left by a time phrase.
   */
  const dateHit = scan(tokens, open, (text) =>
    bookingDate(text, timezone, now)
  );

  let date: string | null = null;
  let dateUnresolved = false;

  if (dateHit) {
    consume(open, dateHit.from, dateHit.to);

    if (offersAlternative(tokens, dateHit.to)) {
      dateUnresolved = true;
    } else {
      date = dateHit.value;
    }
  } else {
    /*
     * Distinguish "no date was mentioned" from "a date was mentioned that we
     * could not resolve", so the caller gets a focused re-ask rather than a
     * silent drop.
     */
    const mention = scan(tokens, open, (text) =>
      /^(?:on |for |the )?(?:january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|tonight|this|next)\b/.test(
        text
      ) && text.split(" ").length <= 3
        ? text
        : null
    );

    dateUnresolved = Boolean(mention);
  }

  /*
   * TIME last among the scheduling fields, on whatever is left. A valid,
   * unambiguous reading is preferred over an ambiguous one anywhere in the
   * utterance, so "at 3 on October 2nd at 2:30 PM" prefers the explicit time.
   */
  let time: TimeInterpretation | null = null;
  let timeSpan: { from: number; to: number } | null = null;

  const exact = scan(tokens, open, (text) => {
    const parsed = parseSpokenTime(text);
    return parsed.kind === "valid" ? parsed : null;
  });

  if (exact) {
    time = exact.value;
    timeSpan = { from: exact.from, to: exact.to };
  } else {
    const loose = scan(tokens, open, (text) => {
      const parsed = parseSpokenTime(text);
      return parsed.kind === "ambiguous" ? parsed : null;
    });

    if (loose) {
      time = loose.value;
      timeSpan = { from: loose.from, to: loose.to };
    }
  }

  if (timeSpan) {
    consume(open, timeSpan.from, timeSpan.to);

    if (offersAlternative(tokens, timeSpan.to)) {
      /* "one or two PM" is a choice, not a booking instruction. */
      time = { kind: "invalid" };
    }
  }

  /*
   * NAME only when asked for, and only from an explicit introduction or a
   * short clean residue. Guessing a name is worse than asking for one.
   */
  let name: string | null = null;

  if (wantName) {
    const introduced = NAME_INTRODUCTION.exec(speech);

    if (introduced) {
      const tail = tokenize(introduced[1]);

      if (tail.length && tail.length <= 5) {
        const candidate = readName(
          tail.map((token) => token.norm).join(" ")
        );

        if (candidate) {
          name = introduced[1]
            .replace(/\s+/g, " ")
            .replace(/[.,!?;:]+$/, "")
            .trim();
        }
      }
    }

    if (!name) {
      const remaining: number[] = [];

      for (let index = 0; index < tokens.length; index += 1) {
        if (open[index]) {
          remaining.push(index);
        }
      }

      /* Only a single contiguous run of leftover words can be a name. */
      const contiguous =
        remaining.length > 0 &&
        remaining[remaining.length - 1] - remaining[0] ===
          remaining.length - 1;

      if (contiguous) {
        const from = remaining[0];
        const to = remaining[remaining.length - 1];

        if (readName(phrase(tokens, from, to))) {
          name = original(speech, tokens, from, to);
        }
      }
    }

    if (
      name &&
      (name.length < 2 ||
        name.length > 120 ||
        /[<>\u0000-\u001f]/.test(name))
    ) {
      name = null;
    }
  }

  return {
    service,
    serviceCandidates,
    date,
    dateUnresolved,
    time,
    name,
    any: Boolean(
      service ||
        serviceCandidates.length ||
        date ||
        dateUnresolved ||
        time ||
        name
    ),
  };
}

/*
 * The mutable booking slots. `time` is availability state: it is non-null only
 * while the database has confirmed this exact service/date/time is free.
 */
export type BookingSlots = {
  customerName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  date: string | null;
  requestedTime?: string | null;
  time: string | null;
};

export type SlotChange = {
  name: boolean;
  service: boolean;
  date: boolean;
  time: boolean;
  /* A previously verified availability answer is now stale. */
  availabilityInvalidated: boolean;
};

export type BookingField =
  | "name"
  | "service"
  | "date"
  | "time";

/*
 * Merge newly understood values into the slots.
 *
 * Only fields the caller actually supplied are touched, so a correction never
 * discards an unrelated field: changing the time keeps the service and date,
 * and changing the service keeps the date and time.
 *
 * Any change to service, date or time invalidates availability, because all
 * three determine the interval that was checked. The caller's requested time
 * survives the invalidation so it can simply be re-checked rather than re-asked.
 */
export function applyBookingDetails(
  slots: BookingSlots,
  details: {
    name?: string | null;
    service?: SlotService | null;
    date?: string | null;
    time?: string | null;
  }
): SlotChange {
  const change: SlotChange = {
    name: false,
    service: false,
    date: false,
    time: false,
    availabilityInvalidated: false,
  };

  if (details.name && details.name !== slots.customerName) {
    slots.customerName = details.name;
    change.name = true;
  }

  if (details.service && details.service.id !== slots.serviceId) {
    slots.serviceId = details.service.id;
    slots.serviceName = details.service.name;
    change.service = true;
  }

  if (details.date && details.date !== slots.date) {
    slots.date = details.date;
    change.date = true;
  }

  if (details.time && details.time !== slots.requestedTime) {
    slots.requestedTime = details.time;
    change.time = true;
  }

  if (change.service || change.date || change.time) {
    change.availabilityInvalidated = slots.time !== null;
    slots.time = null;
  }

  return change;
}

/*
 * The next thing to ask for. Order is stable so the caller is never asked for
 * the same field twice, and a field already supplied is never asked for again.
 */
export function missingBookingField(
  slots: BookingSlots
): BookingField | null {
  if (!slots.customerName) {
    return "name";
  }

  if (!slots.serviceId || !slots.serviceName) {
    return "service";
  }

  if (!slots.date) {
    return "date";
  }

  if (!slots.requestedTime) {
    return "time";
  }

  return null;
}
