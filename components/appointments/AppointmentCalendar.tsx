"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  List,
  Plus,
} from "lucide-react";

import {
  appointmentsForDate,
  monthDateKeys,
  normalizeCalendarTime,
  todayInTimezone,
  type CalendarView,
} from "@/lib/appointment-calendar";

import {
  Button,
} from "@/components/ui/button";

export type AppointmentCalendarItem = {
  id: string;
  customer_name: string;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
};

type AppointmentCalendarProps = {
  appointments: AppointmentCalendarItem[];
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
    date?: string
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

function AppointmentButton({
  appointment,
  compact = false,
  onSelect,
}: {
  appointment: AppointmentCalendarItem;
  compact?: boolean;

  onSelect: (
    appointment: AppointmentCalendarItem
  ) => void;
}) {
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
      aria-label={`Open appointment for ${appointment.customer_name}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClasses(
            appointment.status
          )}`}
          aria-hidden="true"
        />

        <span
          className={`shrink-0 font-semibold ${
            compact
              ? "text-[11px]"
              : "text-xs"
          }`}
        >
          {formatTime(
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
    </button>
  );
}

function MonthView({
  appointments,
  selectedDate,
  today,
  onSelectedDateChange,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  selectedDate: string;
  today: string | null;

  onSelectedDateChange: (
    date: string
  ) => void;

  onNewAppointment: (
    date?: string
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
      <div className="min-w-[760px]">
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
                  className={`relative min-h-[156px] border-b border-r border-gray-100 p-2 align-top transition ${
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
                      className={`flex h-11 min-w-11 items-center justify-center rounded-full px-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-green-200 ${
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

                  <div className="space-y-1.5">
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
                        aria-label={`Show ${hiddenCount} more appointments on ${formatLongDate(
                          date
                        )}`}
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

function SelectedDateAgenda({
  appointments,
  selectedDate,
  onNewAppointment,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
  selectedDate: string;

  onNewAppointment: (
    date?: string
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
  selectedDate,
  onAppointmentSelect,
}: {
  appointments: AppointmentCalendarItem[];
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
            aria-label={`Open appointment for ${appointment.customer_name}`}
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
                {formatTime(
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

function PlaceholderView({
  view,
  selectedDate,
}: {
  view:
    | "week"
    | "day";

  selectedDate: string;
}) {
  return (
    <div className="px-5 py-12 text-center sm:px-6">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-green-50 text-green-700">
        <Clock3
          className="h-6 w-6"
          aria-hidden="true"
        />
      </div>

      <h3 className="mt-4 font-semibold capitalize text-gray-950">
        {view} schedule
      </h3>

      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-gray-500">
        {view === "week"
          ? "The time-grid week schedule will be connected in the next calendar checkpoint."
          : "The detailed day schedule will be connected in the next calendar checkpoint."}
      </p>

      <p className="mt-3 text-xs font-medium text-gray-400">
        {formatLongDate(
          selectedDate
        )}
      </p>
    </div>
  );
}

export default function AppointmentCalendar({
  appointments,
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

  return (
    <section className="anaai-surface overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-4 sm:px-5 sm:py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CalendarDays
                className="h-5 w-5 shrink-0 text-green-700"
                aria-hidden="true"
              />

              <h2 className="anaai-section-title truncate">
                {formatMonthTitle(
                  selectedDate
                )}
              </h2>
            </div>

            <p className="mt-1 truncate text-xs text-gray-500 sm:text-sm">
              Schedule shown in{" "}
              <span className="font-medium text-gray-700">
                {timezone}
              </span>
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
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

      {view === "list" && (
        <ListView
          appointments={
            appointments
          }
          selectedDate={
            selectedDate
          }
          onAppointmentSelect={
            onAppointmentSelect
          }
        />
      )}

      {view === "week" && (
        <PlaceholderView
          view="week"
          selectedDate={
            selectedDate
          }
        />
      )}

      {view === "day" && (
        <PlaceholderView
          view="day"
          selectedDate={
            selectedDate
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-white px-4 py-3 text-[11px] font-medium text-gray-500 sm:px-5">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full bg-amber-500"
            aria-hidden="true"
          />
          Booked
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full bg-green-500"
            aria-hidden="true"
          />
          Confirmed
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full bg-blue-500"
            aria-hidden="true"
          />
          Completed
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full bg-gray-400"
            aria-hidden="true"
          />
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