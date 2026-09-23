"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
} from "lucide-react";

import {
  appointmentEndTime,
  appointmentsForDate,
  calendarTimeSlots,
  minutesFromTime,
  monthDateKeys,
  normalizeCalendarTime,
  todayInTimezone,
  weekDateKeys,
  type CalendarView,
} from "@/lib/appointment-calendar";

import {
  Button,
} from "@/components/ui/button";

export type AppointmentCalendarItem = {
  id: string;
  customer_name: string;
  service_id: string | null;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
};

type AppointmentCalendarService = {
  id: string;
  name: string;
  duration_minutes: number | null;
};

type AppointmentCalendarProps = {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  timezone: string;
  selectedDate: string;
  view: CalendarView;

  onSelectedDateChange: (
    date: string
  ) => void;

  onViewChange: (
    view: CalendarView
  ) => void;

  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;

  onNewAppointment: (
    date?: string,
    time?: string
  ) => void;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
};

const weekDays = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

const views: Array<{
  value: CalendarView;
  label: string;
}> = [
  {
    value: "month",
    label: "Month",
  },
  {
    value: "week",
    label: "Week",
  },
  {
    value: "day",
    label: "Day",
  },
  {
    value: "list",
    label: "List",
  },
];

const timeSlots =
  calendarTimeSlots(
    0,
    24,
    30
  );

function parseDateKey(
  value: string
) {
  const [
    year,
    month,
    day,
  ] = value
    .split("-")
    .map(Number);

  if (
    !year ||
    !month ||
    !day
  ) {
    return null;
  }

  return new Date(
    year,
    month - 1,
    day
  );
}

function formatMonthTitle(
  value: string
) {
  const date =
    parseDateKey(value);

  if (!date) {
    return "Schedule";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "long",
      year: "numeric",
    }
  ).format(date);
}

function formatLongDate(
  value: string
) {
  const date =
    parseDateKey(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }
  ).format(date);
}

function formatShortDate(
  value: string
) {
  const date =
    parseDateKey(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "short",
      month: "short",
      day: "numeric",
    }
  ).format(date);
}

function formatWeekDay(
  value: string
) {
  const date =
    parseDateKey(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "short",
    }
  ).format(date);
}

function formatMonthDay(
  value: string
) {
  const date =
    parseDateKey(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "numeric",
    }
  ).format(date);
}

function formatTime(
  value: string | null
) {
  const normalized =
    normalizeCalendarTime(
      value
    );

  if (!normalized) {
    return "Time TBD";
  }

  const [
    hourText,
    minuteText,
  ] =
    normalized.split(":");

  const hour =
    Number(hourText);

  const period =
    hour >= 12
      ? "PM"
      : "AM";

  const displayHour =
    hour % 12 || 12;

  return `${displayHour}:${minuteText} ${period}`;
}

function statusClasses(
  status: string | null
) {
  switch (status) {
    case "Confirmed":
      return "border-green-200 bg-green-50 text-green-800";

    case "Completed":
      return "border-blue-200 bg-blue-50 text-blue-800";

    case "Cancelled":
      return "border-gray-200 bg-gray-100 text-gray-500";

    default:
      return "border-amber-200 bg-amber-50 text-amber-800";
  }
}

function statusDotClasses(
  status: string | null
) {
  switch (status) {
    case "Confirmed":
      return "bg-green-500";

    case "Completed":
      return "bg-blue-500";

    case "Cancelled":
      return "bg-gray-400";

    default:
      return "bg-amber-500";
  }
}

function sameMonth(
  first: string,
  second: string
) {
  return (
    first.slice(0, 7) ===
    second.slice(0, 7)
  );
}

function dayNumber(
  value: string
) {
  return String(
    Number(
      value.slice(8, 10)
    )
  );
}

function appointmentDurationLabel(
  appointment: AppointmentCalendarItem,
  services: AppointmentCalendarService[]
) {
  const end =
    appointmentEndTime(
      appointment,
      services
    );

  if (!end) {
    return null;
  }

  return `${formatTime(
    appointment.appointment_time
  )} – ${formatTime(end)}`;
}

function appointmentsForSlot(
  appointments: AppointmentCalendarItem[],
  date: string,
  slot: string
) {
  const slotStart =
    minutesFromTime(slot);

  if (slotStart === null) {
    return [];
  }

  const slotEnd =
    slotStart + 30;

  return appointmentsForDate(
    appointments,
    date
  ).filter(
    (appointment) => {
      const start =
        minutesFromTime(
          appointment.appointment_time
        );

      return (
        start !== null &&
        start >= slotStart &&
        start < slotEnd
      );
    }
  );
}

function AppointmentButton({
  appointment,
  services,
  compact = false,
  onSelect,
}: {
  appointment: AppointmentCalendarItem;
  services: AppointmentCalendarService[];
  compact?: boolean;

  onSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const durationLabel =
    appointmentDurationLabel(
      appointment,
      services
    );

  return (
    <button
      type="button"
      onClick={() =>
        onSelect(
          appointment
        )
      }
      className={`w-full rounded-lg border text-left transition focus:outline-none focus:ring-2 focus:ring-green-200 ${
        compact
          ? "min-h-11 px-2 py-1.5"
          : "min-h-14 px-3 py-2.5"
      } ${statusClasses(
        appointment.status
      )}`}
      aria-label={`Open appointment for ${appointment.customer_name}, ${appointment.status || "Status unavailable"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClasses(
            appointment.status
          )}`}
          aria-hidden="true"
        />

        <span
          className={`min-w-0 truncate font-semibold ${
            compact
              ? "text-[11px]"
              : "text-xs"
          }`}
        >
          {durationLabel ||
            formatTime(
              appointment.appointment_time
            )}
        </span>
      </div>

      <p
        className={`mt-1 truncate font-semibold ${
          compact
            ? "text-xs"
            : "text-sm"
        }`}
      >
        {
          appointment.customer_name
        }
      </p>

      {!compact &&
        appointment.service && (
          <p className="mt-0.5 truncate text-xs opacity-75">
            {
              appointment.service
            }
          </p>
        )}
      <span className="mt-1 block text-[10px] font-medium">{appointment.status || "Status unavailable"}</span>
    </button>
  );
}

function MonthView({
  appointments,
  services,
  selectedDate,
  today,
  onSelectedDateChange,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  selectedDate: string;
  today: string | null;

  onSelectedDateChange: (
    date: string
  ) => void;

  onNewAppointment: (
    date?: string,
    time?: string
  ) => void;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const dates =
    monthDateKeys(
      selectedDate
    );

  return (
    <div className="overflow-x-auto">
      <div className="calendar-month">
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
          {weekDays.map(
            (day) => (
              <div
                key={day}
                className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                {day}
              </div>
            )
          )}
        </div>

        <div className="grid grid-cols-7">
          {dates.map(
            (date) => {
              const dayAppointments =
                appointmentsForDate(
                  appointments,
                  date
                );

              const inMonth =
                sameMonth(
                  date,
                  selectedDate
                );

              const isToday =
                date === today;

              const isSelected =
                date ===
                selectedDate;

              const visibleAppointments =
                dayAppointments.slice(
                  0,
                  3
                );

              const hiddenCount =
                Math.max(
                  0,
                  dayAppointments.length -
                    visibleAppointments.length
                );

              return (
                <div
                  key={date}
                  className={`calendar-month-cell relative min-h-[156px] border-b border-r border-gray-100 p-2 ${
                    inMonth
                      ? "bg-white"
                      : "bg-gray-50/70"
                  } ${
                    isSelected
                      ? "ring-2 ring-inset ring-green-500"
                      : ""
                  }`}
                >
                  <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        onSelectedDateChange(
                          date
                        )
                      }
                      className={`calendar-date flex h-11 min-w-11 items-center justify-center rounded-full px-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-green-200 ${
                        isToday
                          ? "bg-green-600 text-white"
                          : isSelected
                            ? "bg-green-50 text-green-800"
                            : inMonth
                              ? "text-gray-800 hover:bg-gray-100"
                              : "text-gray-400 hover:bg-gray-100"
                      }`}
                      aria-label={`Select ${formatLongDate(
                        date
                      )}`}
                      aria-pressed={
                        isSelected
                      }
                    >
                      {dayNumber(
                        date
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        onNewAppointment(
                          date
                        )
                      }
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-green-50 hover:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                      aria-label={`New appointment on ${formatLongDate(
                        date
                      )}`}
                    >
                      <Plus
                        className="h-4 w-4"
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  <p className="calendar-day-count">{dayAppointments.length > 0 ? `${dayAppointments.length} appts` : "—"}</p>
                  <div className="calendar-month-appointments space-y-1.5">
                    {visibleAppointments.map(
                      (
                        appointment
                      ) => (
                        <AppointmentButton
                          key={
                            appointment.id
                          }
                          appointment={
                            appointment
                          }
                          services={
                            services
                          }
                          compact
                          onSelect={
                            onAppointmentSelect
                          }
                        />
                      )
                    )}

                    {hiddenCount >
                      0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectedDateChange(
                            date
                          )
                        }
                        className="min-h-11 w-full rounded-lg px-2 text-left text-xs font-semibold text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-200"
                      >
                        +{hiddenCount}{" "}
                        more
                      </button>
                    )}
                  </div>
                </div>
              );
            }
          )}
        </div>
      </div>
    </div>
  );
}

function TimeSlotAppointment({
  appointment,
  services,
  onAppointmentSelect,
}: {
  appointment: AppointmentCalendarItem;
  services: AppointmentCalendarService[];

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const durationLabel =
    appointmentDurationLabel(
      appointment,
      services
    );

  return (
    <button
      type="button"
      onClick={() =>
        onAppointmentSelect(
          appointment
        )
      }
      className={`w-full rounded-lg border px-2 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-green-200 ${statusClasses(
        appointment.status
      )}`}
      aria-label={`Open appointment for ${appointment.customer_name}, ${appointment.status || "Status unavailable"}`}
    >
      <p className="truncate text-xs font-semibold">
        {
          appointment.customer_name
        }
      </p>

      <p className="mt-0.5 truncate text-[11px] opacity-80">
        {durationLabel ||
          formatTime(
            appointment.appointment_time
          )}
      </p>

      {appointment.service && (
        <p className="mt-0.5 truncate text-[11px] opacity-70">
          {
            appointment.service
          }
        </p>
      )}
      <span className="mt-1 block text-[10px] font-medium">{appointment.status || "Status unavailable"}</span>
    </button>
  );
}

function WeekView({
  appointments,
  services,
  selectedDate,
  today,
  onSelectedDateChange,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  selectedDate: string;
  today: string | null;

  onSelectedDateChange: (
    date: string
  ) => void;

  onNewAppointment: (
    date?: string,
    time?: string
  ) => void;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const dates =
    weekDateKeys(
      selectedDate
    );

  return (
    <div className="overflow-x-auto">
      <div className="calendar-week">
        <div className="sticky top-0 z-20 grid calendar-week-grid border-b border-gray-200 bg-white">
          <div className="border-r border-gray-100 bg-gray-50" />

          {dates.map(
            (date) => {
              const isToday =
                date === today;

              const isSelected =
                date ===
                selectedDate;

              return (
                <button
                  key={date}
                  type="button"
                  onClick={() =>
                    onSelectedDateChange(
                      date
                    )
                  }
                  className={`min-h-16 border-r border-gray-100 px-2 py-2 text-center transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-200 ${
                    isSelected
                      ? "bg-green-50"
                      : "bg-white"
                  }`}
                  aria-pressed={
                    isSelected
                  }
                >
                  <span className="block text-xs font-semibold uppercase text-gray-500">
                    {formatWeekDay(
                      date
                    )}
                  </span>

                  <span
                    className={`mx-auto mt-1 flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm font-bold ${
                      isToday
                        ? "bg-green-600 text-white"
                        : "text-gray-900"
                    }`}
                  >
                    {dayNumber(
                      date
                    )}
                  </span>
                </button>
              );
            }
          )}
        </div>

        <div className="max-h-[680px] overflow-y-auto">
          {timeSlots.map(
            (slot) => (
              <div
                key={slot}
                className="grid calendar-week-grid"
              >
                <div className="flex min-h-16 items-start justify-end border-r border-t border-gray-100 bg-gray-50 px-2 pt-2 text-[11px] font-medium text-gray-500">
                  {formatTime(
                    slot
                  )}
                </div>

                {dates.map(
                  (date) => {
                    const slotAppointments =
                      appointmentsForSlot(
                        appointments,
                        date,
                        slot
                      );

                    return (
                      <div
                        key={`${date}-${slot}`}
                        className={`min-h-16 border-r border-t border-gray-100 p-1 ${
                          date ===
                          selectedDate
                            ? "bg-green-50/20"
                            : "bg-white"
                        }`}
                      >
                        {slotAppointments.length >
                        0 ? (
                          <div className="space-y-1">
                            {slotAppointments.map(
                              (
                                appointment
                              ) => (
                                <TimeSlotAppointment
                                  key={
                                    appointment.id
                                  }
                                  appointment={
                                    appointment
                                  }
                                  services={
                                    services
                                  }
                                  onAppointmentSelect={
                                    onAppointmentSelect
                                  }
                                />
                              )
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                onSelectedDateChange(
                                  date
                                );

                                onNewAppointment(
                                  date,
                                  slot
                                );
                              }}
                              className="flex min-h-11 w-full items-center justify-center rounded-lg text-xs font-semibold text-gray-400 transition hover:bg-green-50 hover:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                              aria-label={`Add appointment on ${formatLongDate(
                                date
                              )} at ${formatTime(
                                slot
                              )}`}
                            >
                              <Plus
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Add
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectedDateChange(
                                date
                              );

                              onNewAppointment(
                                date,
                                slot
                              );
                            }}
                            className="flex min-h-14 w-full items-center justify-center rounded-lg text-gray-300 transition hover:bg-green-50 hover:text-green-700 focus:bg-green-50 focus:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                            aria-label={`Add appointment on ${formatLongDate(
                              date
                            )} at ${formatTime(
                              slot
                            )}`}
                          >
                            <Plus
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </button>
                        )}
                      </div>
                    );
                  }
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function DayView({
  appointments,
  services,
  selectedDate,
  today,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  selectedDate: string;
  today: string | null;

  onNewAppointment: (
    date?: string,
    time?: string
  ) => void;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const isToday =
    selectedDate === today;

  return (
    <div>
      <div className="border-b border-gray-100 bg-gray-50/70 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-gray-950">
              {formatLongDate(
                selectedDate
              )}
            </p>

            <p className="mt-0.5 text-xs text-gray-500">
              30-minute scheduling
              grid
            </p>
          </div>

          {isToday && (
            <span className="mt-2 inline-flex w-fit rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800 sm:mt-0">
              Today
            </span>
          )}
        </div>
      </div>

      <div className="max-h-[720px] overflow-y-auto">
        {timeSlots.map(
          (slot) => {
            const slotAppointments =
              appointmentsForSlot(
                appointments,
                selectedDate,
                slot
              );

            return (
              <div
                key={slot}
                className="grid grid-cols-[88px_minmax(0,1fr)] border-b border-gray-100"
              >
                <div className="border-r border-gray-100 bg-gray-50 px-3 py-3 text-right text-xs font-medium text-gray-500">
                  {formatTime(
                    slot
                  )}
                </div>

                <div className="min-h-[72px] p-2">
                  {slotAppointments.length >
                  0 ? (
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {slotAppointments.map(
                        (
                          appointment
                        ) => (
                          <AppointmentButton
                            key={
                              appointment.id
                            }
                            appointment={
                              appointment
                            }
                            services={
                              services
                            }
                            onSelect={
                              onAppointmentSelect
                            }
                          />
                        )
                      )}

                      <button
                        type="button"
                        onClick={() =>
                          onNewAppointment(
                            selectedDate,
                            slot
                          )
                        }
                        className="flex min-h-14 items-center justify-center rounded-lg border border-dashed border-gray-200 px-3 text-sm font-semibold text-gray-400 transition hover:border-green-300 hover:bg-green-50 hover:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                      >
                        <Plus
                          className="mr-2 h-4 w-4"
                          aria-hidden="true"
                        />
                        Add
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        onNewAppointment(
                          selectedDate,
                          slot
                        )
                      }
                      className="flex min-h-14 w-full items-center rounded-lg border border-transparent px-3 text-left text-sm font-medium text-gray-400 transition hover:border-green-200 hover:bg-green-50 hover:text-green-700 focus:border-green-200 focus:bg-green-50 focus:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
                      aria-label={`Add appointment at ${formatTime(
                        slot
                      )}`}
                    >
                      <Plus
                        className="mr-2 h-4 w-4"
                        aria-hidden="true"
                      />
                      Add appointment at{" "}
                      {formatTime(
                        slot
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}

function SelectedDateAgenda({
  appointments,
  services,
  selectedDate,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  selectedDate: string;

  onNewAppointment: (
    date?: string,
    time?: string
  ) => void;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const dayAppointments =
    appointmentsForDate(
      appointments,
      selectedDate
    );

  return (
    <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-950">
            {formatLongDate(
              selectedDate
            )}
          </p>

          <p className="mt-0.5 text-xs text-gray-500">
            {dayAppointments.length ===
            1
              ? "1 appointment"
              : `${dayAppointments.length} appointments`}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onNewAppointment(
              selectedDate
            )
          }
          className="min-h-11 w-full sm:w-auto"
        >
          <Plus
            className="mr-2 h-4 w-4"
            aria-hidden="true"
          />
          Add appointment
        </Button>
      </div>

      {dayAppointments.length >
      0 ? (
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {dayAppointments.map(
            (
              appointment
            ) => (
              <AppointmentButton
                key={
                  appointment.id
                }
                appointment={
                  appointment
                }
                services={
                  services
                }
                onSelect={
                  onAppointmentSelect
                }
              />
            )
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() =>
            onNewAppointment(
              selectedDate
            )
          }
          className="mt-4 flex min-h-20 w-full items-center justify-center rounded-xl border border-dashed border-gray-200 bg-white px-4 text-sm font-medium text-gray-500 transition hover:border-green-300 hover:bg-green-50/50 hover:text-green-700 focus:outline-none focus:ring-2 focus:ring-green-200"
        >
          No appointments on this
          date. Tap to add one.
        </button>
      )}
    </div>
  );
}

function ListView({
  appointments,
  services,
  selectedDate,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  services: AppointmentCalendarService[];
  selectedDate: string;

  onAppointmentSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
  const month =
    selectedDate.slice(
      0,
      7
    );

  const monthAppointments =
    [...appointments]
      .filter(
        (appointment) =>
          appointment.appointment_date?.startsWith(
            month
          )
      )
      .sort(
        (
          first,
          second
        ) => {
          const firstDate =
            first.appointment_date ||
            "9999-99-99";

          const secondDate =
            second.appointment_date ||
            "9999-99-99";

          const dateCompare =
            firstDate.localeCompare(
              secondDate
            );

          if (dateCompare) {
            return dateCompare;
          }

          const firstTime =
            normalizeCalendarTime(
              first.appointment_time
            ) || "99:99";

          const secondTime =
            normalizeCalendarTime(
              second.appointment_time
            ) || "99:99";

          return firstTime.localeCompare(
            secondTime
          );
        }
      );

  if (
    monthAppointments.length ===
    0
  ) {
    return (
      <div className="px-5 py-12 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-green-50 text-green-700">
          <CalendarDays
            className="h-6 w-6"
            aria-hidden="true"
          />
        </div>

        <h3 className="mt-4 font-semibold text-gray-950">
          No appointments this
          month
        </h3>

        <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-gray-500">
          Appointments for this
          month will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100">
      {monthAppointments.map(
        (appointment) => (
          <button
            key={
              appointment.id
            }
            type="button"
            onClick={() =>
              onAppointmentSelect(
                appointment
              )
            }
            className="flex min-h-20 w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-gray-50 focus:bg-green-50/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-200"
          >
            <div className="w-24 shrink-0">
              <p className="text-xs font-semibold text-gray-500">
                {appointment.appointment_date
                  ? formatShortDate(
                      appointment.appointment_date
                    )
                  : "No date"}
              </p>

              <p className="mt-1 text-sm font-bold text-gray-950">
                {appointmentDurationLabel(
                  appointment,
                  services
                ) ||
                  formatTime(
                    appointment.appointment_time
                  )}
              </p>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold text-gray-950">
                  {
                    appointment.customer_name
                  }
                </p>

                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClasses(
                    appointment.status
                  )}`}
                >
                  {appointment.status ||
                    "Booked"}
                </span>
              </div>

              <p className="mt-1 truncate text-xs text-gray-500">
                {appointment.service ||
                  "Service not specified"}
              </p>
            </div>
          </button>
        )
      )}
    </div>
  );
}

export default function AppointmentCalendar({
  appointments,
  services,
  timezone,
  selectedDate,
  view,
  onSelectedDateChange,
  onViewChange,
  onToday,
  onPrevious,
  onNext,
  onNewAppointment,
  onAppointmentSelect,
}: AppointmentCalendarProps) {
  const today =
    todayInTimezone(
      timezone
    );

  const title =
    view === "day"
      ? formatLongDate(
          selectedDate
        )
      : view === "week"
        ? `Week of ${formatMonthDay(
            weekDateKeys(
              selectedDate
            )[0] ||
              selectedDate
          )}`
        : formatMonthTitle(
            selectedDate
          );

  return (
    <section className="calendar-shell anaai-surface overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-4 sm:px-5 sm:py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CalendarDays
                className="h-5 w-5 shrink-0 text-green-700"
                aria-hidden="true"
              />

              <h2 className="anaai-section-title truncate">
                {title}
              </h2>
            </div>

            <p className="mt-1 truncate text-xs text-gray-500 sm:text-sm">
              Schedule shown in{" "}
              <span className="font-medium text-gray-700">
                {timezone}
              </span>
            </p>
          </div>

          <div className="calendar-controls flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
            <div className="grid grid-cols-[auto_1fr_auto] gap-2 sm:flex sm:items-center">
              <Button
                type="button"
                variant="outline"
                onClick={
                  onPrevious
                }
                className="h-11 w-11 p-0"
                aria-label={`Previous ${view}`}
              >
                <ChevronLeft
                  className="h-4 w-4"
                  aria-hidden="true"
                />
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={
                  onToday
                }
                className="min-h-11"
              >
                Today
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={
                  onNext
                }
                className="h-11 w-11 p-0"
                aria-label={`Next ${view}`}
              >
                <ChevronRight
                  className="h-4 w-4"
                  aria-hidden="true"
                />
              </Button>
            </div>

            <div
              className="grid grid-cols-4 rounded-xl border border-gray-200 bg-gray-50 p-1"
              role="group"
              aria-label="Calendar view"
            >
              {views.map(
                (option) => {
                  const active =
                    option.value ===
                    view;

                  return (
                    <button
                      key={
                        option.value
                      }
                      type="button"
                      onClick={() =>
                        onViewChange(
                          option.value
                        )
                      }
                      aria-pressed={
                        active
                      }
                      className={`min-h-11 rounded-lg px-3 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-green-200 sm:text-sm ${
                        active
                          ? "bg-white text-green-700 shadow-sm ring-1 ring-gray-200"
                          : "text-gray-500 hover:text-gray-900"
                      }`}
                    >
                      {
                        option.label
                      }
                    </button>
                  );
                }
              )}
            </div>

            <Button
              type="button"
              onClick={() =>
                onNewAppointment(
                  selectedDate
                )
              }
              className="min-h-11 w-full lg:w-auto"
            >
              <Plus
                className="mr-2 h-4 w-4"
                aria-hidden="true"
              />
              New appointment
            </Button>
          </div>
        </div>
      </div>

      {view === "month" && (
        <>
          <MonthView
            appointments={
              appointments
            }
            services={
              services
            }
            selectedDate={
              selectedDate
            }
            today={
              today
            }
            onSelectedDateChange={
              onSelectedDateChange
            }
            onNewAppointment={
              onNewAppointment
            }
            onAppointmentSelect={
              onAppointmentSelect
            }
          />

          <SelectedDateAgenda
            appointments={
              appointments
            }
            services={
              services
            }
            selectedDate={
              selectedDate
            }
            onNewAppointment={
              onNewAppointment
            }
            onAppointmentSelect={
              onAppointmentSelect
            }
          />
        </>
      )}

      {view === "week" && (
        <WeekView
          appointments={
            appointments
          }
          services={
            services
          }
          selectedDate={
            selectedDate
          }
          today={
            today
          }
          onSelectedDateChange={
            onSelectedDateChange
          }
          onNewAppointment={
            onNewAppointment
          }
          onAppointmentSelect={
            onAppointmentSelect
          }
        />
      )}

      {view === "day" && (
        <DayView
          appointments={
            appointments
          }
          services={
            services
          }
          selectedDate={
            selectedDate
          }
          today={
            today
          }
          onNewAppointment={
            onNewAppointment
          }
          onAppointmentSelect={
            onAppointmentSelect
          }
        />
      )}

      {view === "list" && (
        <ListView
          appointments={
            appointments
          }
          services={
            services
          }
          selectedDate={
            selectedDate
          }
          onAppointmentSelect={
            onAppointmentSelect
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-white px-4 py-3 text-[11px] font-medium text-gray-500 sm:px-5">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          Booked
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Confirmed
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-blue-500" />
          Completed
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-gray-400" />
          Cancelled
        </span>

        <span className="ml-auto hidden items-center gap-1.5 text-gray-400 sm:inline-flex">
          <List
            className="h-3.5 w-3.5"
            aria-hidden="true"
          />
          Tap an appointment to manage it
        </span>
      </div>
    </section>
  );
}
