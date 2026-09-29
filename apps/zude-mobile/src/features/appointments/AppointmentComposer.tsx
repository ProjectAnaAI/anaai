import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { router } from "expo-router";
import { dateLabel } from "../../components/datePresentation";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Field,
  SplitWorkspace,
  WorkspaceHeader,
} from "../../components/workspace";
import { Badge, Icon } from "../../components/ui";
import { workspaceLayout } from "../../theme/layout";
import { theme as t } from "../../theme/tokens";
import { ComposerSection } from "./ComposerSection";
import { AppointmentSummary } from "./AppointmentSummary";
import {
  getAvailability,
  getCustomers,
  getServices,
  type Appointment,
  type Customer,
} from "../../lib/appointments-api";
import { createCustomer } from "../../lib/customers-api";
import { useBusiness } from "../business/BusinessContext";
import { performAction } from "./requestKeys";
import {
  isSlotConflict,
  recoverConflict,
  safeMessage,
  shiftDate,
  timeLabel,
  uncertainAction,
  validDate,
} from "./state";
import { useResource } from "./useResource";
import { Action, Notice, s } from "./controls";

function dateFromYmd(value: string) {
  const [year, month, day] = value.split("-").map(Number);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return new Date();
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function ymdFromDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function AppointmentComposer({
  initialDate,
  today,
  appointment,
  initialCustomer,
  onClose,
  onSaved,
  onView: _onView,
  onLockChange,
}: {
  initialDate: string;
  today: string;
  appointment?: Appointment;
  initialCustomer?: Customer | null;
  onClose: () => void;
  onSaved: (appointment: Appointment) => void;
  onView: (appointment: Appointment) => void;
  onLockChange?: (locked: boolean) => void;
}) {
  const { business, userId } = useBusiness();
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const layout = workspaceLayout(width, height, fontScale);

  const [serviceEditing, setServiceEditing] = useState(true);
  const [dateChosen, setDateChosen] = useState(!!appointment);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [timeEditing, setTimeEditing] = useState(false);

  const [selection, setSelection] = useState({
    date: initialDate,
    time: "",
    serviceId: appointment?.service_id || "",
  });

  const [customer, setCustomer] = useState<Customer | null>(
    appointment?.customer_id
      ? {
          id: appointment.customer_id,
          full_name: appointment.customer_name || "Customer",
          phone: null,
        }
      : initialCustomer || null,
  );

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [offset, setOffset] = useState(0);

  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);

  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState<Appointment | null>(null);

  const locked =
    busy ||
    pending !== null ||
    success !== null;

  const alive = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    onLockChange?.(locked);

    return () => {
      onLockChange?.(false);
    };
  }, [locked, onLockChange]);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, []);

  /*
   * Debounce customer search.
   *
   * The customer-name input always remains mounted while the receptionist
   * types. A completed search never freezes the input.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

  const scope = `${userId}:${business.id}`;

  /*
   * Never load the customer directory before a name has been entered.
   */
  const customers = useResource(
    !customer && !appointment && !!query
      ? `${scope}:customers:${query}:${offset}`
      : null,
    (signal) =>
      getCustomers(
        business.id,
        query,
        offset,
        signal,
      ),
  );

  const currentSearch = search.trim();

  /*
   * A typed name becomes a valid new-customer candidate once the CURRENT
   * customer lookup has completed successfully.
   *
   * Existing matches do NOT invalidate the new customer.
   *
   * This means:
   *
   * "Sam Johnson"
   *
   * may simultaneously have:
   * - one or more existing customer suggestions
   * - a valid new-customer candidate
   *
   * Selecting an existing customer is always explicit.
   */
  const currentCustomerSearchComplete =
    !appointment &&
    !customer &&
    !!currentSearch &&
    !!query &&
    currentSearch === query &&
    !customers.loading &&
    !customers.error &&
    customers.data != null;

  const newCustomerName =
    currentCustomerSearchComplete
      ? currentSearch
      : "";

  const isNewCustomer =
    !!newCustomerName;

  const hasCustomer =
    !!customer || isNewCustomer;

  /*
   * TypeScript does not preserve the customers.data narrowing through the
   * separate currentCustomerSearchComplete boolean, so optional chaining is
   * intentionally used here.
   */
  const hasCurrentMatches =
    currentCustomerSearchComplete &&
    (customers.data?.customers.length ?? 0) > 0;

  const customerSearchPending =
    !customer &&
    !!currentSearch &&
    (
      currentSearch !== query ||
      customers.loading
    );

  const services = useResource(
    `${scope}:services`,
    (signal) =>
      getServices(
        business.id,
        signal,
      ),
  );

  const service =
    services.data?.find(
      (item) =>
        item.id === selection.serviceId,
    );

  const availability = useResource(
    selection.serviceId &&
      dateChosen &&
      validDate(selection.date) &&
      !success
      ? `${scope}:availability:${selection.date}:${selection.serviceId}:${
          appointment?.id || ""
        }`
      : null,
    (signal) =>
      getAvailability(
        business.id,
        selection.date,
        selection.serviceId,
        appointment?.id,
        signal,
      ),
  );

  /*
   * A selected time remains valid only while it still exists in the latest
   * authoritative availability response.
   */
  const selectedTime =
    availability.data?.slots.includes(
      selection.time,
    )
      ? selection.time
      : "";

  const ready =
    hasCustomer &&
    !!service &&
    dateChosen &&
    !!selectedTime &&
    !busy &&
    !success;

  /*
   * After a successful save, show the confirmation state for five seconds,
   * then return to the real Today screen.
   */
  useEffect(() => {
    if (!success) return;

    const timer = setTimeout(() => {
      router.replace("/");
    }, 5000);

    return () =>
      clearTimeout(timer);
  }, [success]);

  function change(
    patch: Partial<typeof selection>,
  ) {
    setSelection((previous) => ({
      ...previous,
      ...patch,
      time: "",
    }));

    setMessage("");
  }

  function chooseExistingCustomer(
    selectedCustomer: Customer,
  ) {
    setCustomer(selectedCustomer);

    setNewCustomerPhone("");
    setSearch("");
    setQuery("");
    setOffset(0);
    setMessage("");
  }

  function changeCustomer() {
    if (locked || appointment) {
      return;
    }

    setCustomer(null);
    setNewCustomerPhone("");
    setSearch("");
    setQuery("");
    setOffset(0);
    setMessage("");
  }

  function chooseDate(date: string) {
    if (!validDate(date)) {
      return;
    }

    setSelection((previous) => ({
      ...previous,
      date,
      time: "",
    }));

    setDateChosen(true);
    setShowDatePicker(false);
    setTimeEditing(false);
    setMessage("");
  }

  function handleNativeDateChange(
    event: DateTimePickerEvent,
    pickedDate?: Date,
  ) {
    if (
      event.type === "dismissed" ||
      !pickedDate
    ) {
      setShowDatePicker(false);
      return;
    }

    chooseDate(
      ymdFromDate(pickedDate),
    );
  }

  async function submit() {
    if (
      (!ready && !pending) ||
      submitting.current
    ) {
      return;
    }

    /*
     * When an existing customer has NOT been explicitly selected, the current
     * verified typed name is the customer to create.
     */
    const candidateName =
      newCustomerName.trim();

    if (
      !customer &&
      !candidateName
    ) {
      return;
    }

    submitting.current = true;
    setBusy(true);
    setMessage("");

    try {
      let bookingCustomer =
        customer;

      /*
       * New customers are created only when Book Appointment is pressed.
       *
       * Typing a name, receiving suggestions, and entering a phone number do
       * not persist anything to CRM.
       */
      if (!bookingCustomer) {
        const created =
          await createCustomer(
            business.id,
            userId,
            {
              name: candidateName,
              phone: newCustomerPhone,
              email: "",
              notes: "",
            },
          );

        if (!alive.current) {
          return;
        }

        /*
         * Immediately retain the authoritative customer returned by the API.
         *
         * If appointment scheduling subsequently fails, a retry uses this
         * real customer instead of creating another customer.
         */
        bookingCustomer = {
          id: created.id,
          full_name:
            created.full_name,
          phone: created.phone,
        };

        setCustomer(
          bookingCustomer,
        );

        setNewCustomerPhone("");
        setSearch("");
        setQuery("");
      }

      const body =
        pending || {
          ...(appointment
            ? {
                appointmentId:
                  appointment.id,
              }
            : {}),
          customerId:
            bookingCustomer.id,
          serviceId:
            selection.serviceId,
          appointmentDate:
            selection.date,
          appointmentTime:
            selectedTime,
          notes:
            appointment?.notes ||
            null,
        };

      setPending(body);

      const result =
        await performAction(
          userId,
          business.id,
          body,
        );

      if (!alive.current) {
        return;
      }

      setPending(null);
      setSuccess(result);
      onSaved(result);
    } catch (error) {
      if (!alive.current) {
        return;
      }

      if (
        !uncertainAction(error)
      ) {
        setPending(null);
      }

      setMessage(
        safeMessage(error),
      );

      if (
        isSlotConflict(error)
      ) {
        setSelection(
          (previous) =>
            recoverConflict(
              previous,
            ),
        );

        availability.refresh();
      }
    } finally {
      submitting.current =
        false;

      if (alive.current) {
        setBusy(false);
      }
    }
  }

  const showServices =
    !appointment &&
    (
      !service ||
      serviceEditing
    );

  const customerDisplayName =
    success?.customer_name ||
    customer?.full_name ||
    newCustomerName ||
    undefined;

  const footer =
    success ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent:
            "center",
          gap: t.space.sm,
          minHeight:
            t.layout.touch,
        }}
      >
        <ActivityIndicator
          accessibilityLabel="Returning to Today"
          color={
            t.colors.emerald
          }
        />

        <Text style={s.muted}>
          Returning to Today…
        </Text>
      </View>
    ) : (
      <>
        {message ? (
          <Notice
            message={message}
          />
        ) : null}

        {pending &&
        !busy ? (
          <Notice message="The save outcome is uncertain. Retry this same request before changing selections or closing." />
        ) : null}

        <Action
          label={
            busy
              ? "Saving…"
              : pending
                ? "Retry Same Request"
                : appointment
                  ? "Save Reschedule"
                  : "Book Appointment"
          }
          icon="check"
          busy={busy}
          disabled={
            busy ||
            (
              !ready &&
              !pending
            )
          }
          onPress={() =>
            void submit()
          }
        />
      </>
    );

  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={
        Platform.OS === "ios"
          ? "padding"
          : "height"
      }
      keyboardVerticalOffset={
        insets.top
      }
    >
      <WorkspaceHeader
        operational
        title={
          success
            ? appointment
              ? "Appointment Rescheduled"
              : "Appointment Saved"
            : appointment
              ? "Reschedule Appointment"
              : "New Appointment"
        }
        business={
          business.name
        }
        subtitle={
          success
            ? `${dateLabel(
                success.appointment_date,
              )} · ${timeLabel(
                success.appointment_time,
              )}`
            : dateChosen
              ? dateLabel(
                  selection.date,
                )
              : undefined
        }
        action={
          success
            ? undefined
            : (
                <Action
                  label="Close"
                  secondary
                  disabled={
                    locked
                  }
                  onPress={
                    onClose
                  }
                />
              )
        }
      />

      <SplitWorkspace
        footer={footer}
        rail={
          <AppointmentSummary
            customer={
              customerDisplayName
            }
            service={
              success?.service ||
              service?.name ||
              appointment?.service ||
              undefined
            }
            date={
              success?.appointment_date ||
              (
                dateChosen
                  ? selection.date
                  : ""
              )
            }
            time={
              success?.appointment_time ||
              selectedTime
            }
            duration={
              success?.duration_minutes ??
              service?.duration_minutes
            }
            ready={
              ready &&
              !appointment
            }
          />
        }
        main={
          success ? (
            <View
              style={[
                s.section,
                {
                  paddingVertical:
                    t.space.xxl,
                  alignItems:
                    "center",
                },
              ]}
            >
              <Icon
                name="check-circle"
                color={
                  t.colors.emerald
                }
                size={42}
              />

              <Text
                style={s.title}
              >
                {appointment
                  ? "Appointment Rescheduled"
                  : "Appointment Saved"}
              </Text>

              <Text
                style={s.heading}
              >
                {
                  success.customer_name
                }
              </Text>

              <Text
                style={s.text}
              >
                {success.service}
              </Text>

              <Text
                style={s.text}
              >
                {dateLabel(
                  success.appointment_date,
                )}{" "}
                ·{" "}
                {timeLabel(
                  success.appointment_time,
                )}
              </Text>

              <Badge
                label={
                  success.status
                }
                tone={
                  success.status ===
                  "Confirmed"
                    ? "success"
                    : "warning"
                }
              />

              <View
                style={{
                  flexDirection:
                    "row",
                  alignItems:
                    "center",
                  gap: t.space.sm,
                  marginTop:
                    t.space.md,
                }}
              >
                <ActivityIndicator
                  accessibilityLabel="Returning to Today"
                  color={
                    t.colors.emerald
                  }
                />

                <Text
                  style={s.muted}
                >
                  Returning to
                  Today…
                </Text>
              </View>
            </View>
          ) : (
            <>
              <ComposerSection
                number={1}
                title="Customer"
                complete={
                  hasCustomer
                }
                value={
                  customer
                    ? customer.full_name
                    : undefined
                }
                trailing={
                  customer &&
                  !appointment ? (
                    <Action
                      label="Change customer"
                      secondary
                      disabled={
                        locked
                      }
                      onPress={
                        changeCustomer
                      }
                    />
                  ) : undefined
                }
              >
                {!customer ? (
                  <View
                    style={[
                      customerStyles.searchLayout,
                      !layout.compact &&
                        customerStyles.searchLayoutWide,
                    ]}
                  >
                    <View
                      style={[
                        customerStyles.searchColumn,
                        !layout.compact &&
                          customerStyles.searchColumnWide,
                      ]}
                    >
                      <Field
                        label="Customer name"
                        search
                        placeholder="Enter or search customer name"
                        value={
                          search
                        }
                        editable={
                          !locked
                        }
                        autoCorrect={
                          false
                        }
                        onChangeText={(
                          value,
                        ) => {
                          setSearch(
                            value,
                          );

                          /*
                           * The optional phone belongs to the currently typed
                           * new customer. Editing the name clears it so a phone
                           * cannot accidentally carry over to another person.
                           */
                          if (
                            value.trim() !==
                            search.trim()
                          ) {
                            setNewCustomerPhone(
                              "",
                            );
                          }

                          setMessage(
                            "",
                          );
                        }}
                      />

                      {customerSearchPending ? (
                        <View
                          style={
                            customerStyles.searchStatus
                          }
                        >
                          <ActivityIndicator
                            accessibilityLabel="Searching customers"
                            color={
                              t.colors.emerald
                            }
                          />

                          <Text
                            style={
                              s.muted
                            }
                          >
                            Searching
                            customers…
                          </Text>
                        </View>
                      ) : null}

                      {!!query &&
                      currentSearch ===
                        query &&
                      customers.error ? (
                        <>
                          <Notice
                            message={
                              customers.error
                            }
                            error
                          />

                          <Action
                            label="Retry customer search"
                            secondary
                            onPress={
                              customers.refresh
                            }
                          />
                        </>
                      ) : null}

                      {/*
                       * The new-customer path remains available even when
                       * matching existing customers exist.
                       */}
                      {isNewCustomer ? (
                        <View
                          style={
                            customerStyles.newCustomer
                          }
                        >
                          <View
                            style={
                              s.row
                            }
                          >
                            <Icon
                              name="user"
                              color={
                                t.colors.emerald
                              }
                            />

                            <View
                              style={
                                customerStyles.newCustomerText
                              }
                            >
                              <Text
                                style={[
                                  s.heading,
                                  {
                                    color:
                                      t
                                        .colors
                                        .emerald,
                                  },
                                ]}
                              >
                                New
                                customer
                              </Text>

                              {hasCurrentMatches ? (
                                <Text
                                  style={
                                    s.muted
                                  }
                                >
                                  Or
                                  select
                                  an
                                  existing
                                  matching
                                  customer.
                                </Text>
                              ) : null}
                            </View>
                          </View>

                          <Field
                            label="Phone (optional)"
                            placeholder="Phone (optional)"
                            value={
                              newCustomerPhone
                            }
                            editable={
                              !locked
                            }
                            keyboardType="phone-pad"
                            autoCorrect={
                              false
                            }
                            autoCapitalize="none"
                            onChangeText={(
                              value,
                            ) => {
                              setNewCustomerPhone(
                                value,
                              );

                              setMessage(
                                "",
                              );
                            }}
                          />
                        </View>
                      ) : null}
                    </View>

                    {/*
                     * Existing customers are suggestions only.
                     *
                     * On iPad they appear in the right-side panel.
                     * On compact layouts they stack below.
                     *
                     * Customers sharing the same name remain separate records
                     * because each row is selected using its authoritative ID.
                     */}
                    {hasCurrentMatches ? (
                      <View
                        style={[
                          customerStyles.matches,
                          layout.compact
                            ? customerStyles.matchesCompact
                            : customerStyles.matchesWide,
                        ]}
                      >
                        <View
                          style={
                            customerStyles.matchesHeader
                          }
                        >
                          <View
                            style={
                              customerStyles.matchesHeaderText
                            }
                          >
                            <Text
                              style={
                                customerStyles.matchesTitle
                              }
                            >
                              Possible
                              matches
                            </Text>

                            <Text
                              style={
                                customerStyles.matchesSubtitle
                              }
                            >
                              Select only
                              if this is
                              the same
                              customer.
                            </Text>
                          </View>

                          <Text
                            style={
                              customerStyles.matchesCount
                            }
                          >
                            {
                              customers
                                .data
                                ?.customers
                                .length ??
                              0
                            }
                          </Text>
                        </View>

                        {customers.data?.customers.map(
                          (
                            item,
                          ) => (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Select ${item.full_name}${
                                item.phone
                                  ? `, ${item.phone}`
                                  : ", no phone number"
                              }`}
                              disabled={
                                locked
                              }
                              key={
                                item.id
                              }
                              style={({
                                pressed,
                              }) => [
                                customerStyles.match,
                                pressed &&
                                  customerStyles.matchPressed,
                              ]}
                              onPress={() =>
                                chooseExistingCustomer(
                                  item,
                                )
                              }
                            >
                              <View
                                style={
                                  customerStyles.matchRow
                                }
                              >
                                <View
                                  style={
                                    customerStyles.matchIcon
                                  }
                                >
                                  <Icon
                                    name="user"
                                    size={
                                      16
                                    }
                                  />
                                </View>

                                <View
                                  style={
                                    customerStyles.matchText
                                  }
                                >
                                  <Text
                                    style={
                                      customerStyles.matchName
                                    }
                                    numberOfLines={
                                      1
                                    }
                                  >
                                    {
                                      item.full_name
                                    }
                                  </Text>

                                  <Text
                                    style={
                                      customerStyles.matchPhone
                                    }
                                    numberOfLines={
                                      1
                                    }
                                  >
                                    {item.phone ||
                                      "No phone number"}
                                  </Text>
                                </View>

                                <Icon
                                  name="chevron-right"
                                  size={
                                    16
                                  }
                                />
                              </View>
                            </Pressable>
                          ),
                        )}

                        {offset >
                          0 ||
                        customers
                          .data
                          ?.nextOffset !=
                          null ? (
                          <View
                            style={
                              customerStyles.pagination
                            }
                          >
                            {offset >
                            0 ? (
                              <Action
                                label="Previous"
                                secondary
                                disabled={
                                  locked
                                }
                                onPress={() =>
                                  setOffset(
                                    Math.max(
                                      0,
                                      offset -
                                        25,
                                    ),
                                  )
                                }
                              />
                            ) : null}

                            {customers
                              .data
                              ?.nextOffset !=
                            null ? (
                              <Action
                                label="More"
                                secondary
                                disabled={
                                  locked
                                }
                                onPress={() => {
                                  const nextOffset =
                                    customers
                                      .data
                                      ?.nextOffset;

                                  if (
                                    nextOffset !=
                                    null
                                  ) {
                                    setOffset(
                                      nextOffset,
                                    );
                                  }
                                }}
                              />
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </ComposerSection>

              <ComposerSection
                number={2}
                title="Service"
                complete={
                  !!service &&
                  !showServices
                }
                value={
                  !showServices
                    ? `${
                        service?.name ||
                        appointment?.service ||
                        "Service unavailable"
                      } · ${
                        service?.duration_minutes ??
                        "—"
                      } min`
                    : undefined
                }
                trailing={
                  service &&
                  !appointment &&
                  !showServices ? (
                    <Action
                      label="Change service"
                      secondary
                      disabled={
                        locked
                      }
                      onPress={() =>
                        setServiceEditing(
                          true,
                        )
                      }
                    />
                  ) : undefined
                }
              >
                {!hasCustomer ? (
                  <Text
                    style={s.muted}
                  >
                    Enter a customer
                    name or select an
                    existing customer
                    to continue.
                  </Text>
                ) : (
                  <>
                    {services.loading ? (
                      <ActivityIndicator
                        accessibilityLabel="Loading services"
                        color={
                          t.colors
                            .emerald
                        }
                      />
                    ) : null}

                    {services.error ? (
                      <>
                        <Notice
                          message={
                            services.error
                          }
                          error
                        />

                        <Action
                          label="Retry services"
                          secondary
                          onPress={
                            services.refresh
                          }
                        />
                      </>
                    ) : null}

                    {showServices ? (
                      <View
                        style={s.row}
                      >
                        {services.data?.map(
                          (
                            item,
                          ) => (
                            <Action
                              key={
                                item.id
                              }
                              label={`${item.name} · ${item.duration_minutes} min${
                                item.id ===
                                selection.serviceId
                                  ? " ✓"
                                  : ""
                              }`}
                              secondary
                              selected={
                                item.id ===
                                selection.serviceId
                              }
                              disabled={
                                locked ||
                                !(
                                  item.duration_minutes >
                                  0
                                )
                              }
                              onPress={() => {
                                change(
                                  {
                                    serviceId:
                                      item.id,
                                  },
                                );

                                if (
                                  !appointment
                                ) {
                                  setDateChosen(
                                    false,
                                  );

                                  setShowDatePicker(
                                    false,
                                  );
                                }

                                setServiceEditing(
                                  false,
                                );
                              }}
                            />
                          ),
                        )}
                      </View>
                    ) : null}

                    {services.data
                      ?.length ===
                    0 ? (
                      <Text
                        style={
                          s.muted
                        }
                      >
                        No active
                        services.
                        Configure
                        services in
                        the existing
                        web
                        workspace.
                      </Text>
                    ) : null}

                    {appointment &&
                    services.data &&
                    !service ? (
                      <Notice message="This service is no longer active. Review it in the existing web workspace before rescheduling." />
                    ) : null}
                  </>
                )}
              </ComposerSection>

              <ComposerSection
                number={3}
                title="Date"
                complete={
                  !!service &&
                  dateChosen &&
                  validDate(
                    selection.date,
                  )
                }
                value={
                  service &&
                  dateChosen
                    ? `${dateLabel(
                        selection.date,
                      )}${
                        selection.date ===
                        today
                          ? " · Today"
                          : selection.date ===
                              shiftDate(
                                today,
                                1,
                              )
                            ? " · Tomorrow"
                            : ""
                      }`
                    : undefined
                }
                trailing={
                  service &&
                  dateChosen ? (
                    <Action
                      label="Change date"
                      secondary
                      disabled={
                        locked
                      }
                      onPress={() => {
                        setDateChosen(
                          false,
                        );

                        setShowDatePicker(
                          false,
                        );

                        setSelection(
                          (
                            previous,
                          ) => ({
                            ...previous,
                            time: "",
                          }),
                        );

                        setTimeEditing(
                          false,
                        );

                        setMessage(
                          "",
                        );
                      }}
                    />
                  ) : undefined
                }
              >
                {!service ? (
                  <Text
                    style={s.muted}
                  >
                    Choose a service
                    first.
                  </Text>
                ) : !dateChosen ? (
                  <>
                    <Text
                      style={s.muted}
                    >
                      Choose the
                      appointment
                      date.
                    </Text>

                    <View
                      style={s.row}
                    >
                      <Action
                        label="Today"
                        secondary
                        disabled={
                          locked
                        }
                        onPress={() =>
                          chooseDate(
                            today,
                          )
                        }
                      />

                      <Action
                        label="Tomorrow"
                        secondary
                        disabled={
                          locked
                        }
                        onPress={() =>
                          chooseDate(
                            shiftDate(
                              today,
                              1,
                            ),
                          )
                        }
                      />

                      <Action
                        label={
                          showDatePicker
                            ? "Hide Date Picker"
                            : "Choose Date"
                        }
                        icon="calendar"
                        secondary
                        disabled={
                          locked
                        }
                        onPress={() =>
                          setShowDatePicker(
                            (
                              current,
                            ) =>
                              !current,
                          )
                        }
                      />
                    </View>

                    {showDatePicker ? (
                      <View
                        style={{
                          alignSelf:
                            "flex-start",
                          minWidth:
                            320,
                        }}
                      >
                        <DateTimePicker
                          value={dateFromYmd(
                            validDate(
                              selection.date,
                            )
                              ? selection.date
                              : today,
                          )}
                          mode="date"
                          display={
                            Platform.OS ===
                            "ios"
                              ? "inline"
                              : "default"
                          }
                          minimumDate={dateFromYmd(
                            today,
                          )}
                          onChange={
                            handleNativeDateChange
                          }
                        />
                      </View>
                    ) : null}
                  </>
                ) : null}
              </ComposerSection>

              <ComposerSection
                number={4}
                title="Available time"
                complete={
                  !!selectedTime &&
                  !timeEditing
                }
                value={
                  selectedTime &&
                  !timeEditing
                    ? timeLabel(
                        selectedTime,
                      )
                    : undefined
                }
                trailing={
                  selectedTime &&
                  !timeEditing ? (
                    <Action
                      label="Change time"
                      secondary
                      disabled={
                        locked
                      }
                      onPress={() =>
                        setTimeEditing(
                          true,
                        )
                      }
                    />
                  ) : undefined
                }
              >
                {!selection.serviceId ? (
                  <Text
                    style={s.muted}
                  >
                    Available times
                    will appear
                    after you
                    select a
                    service.
                  </Text>
                ) : !dateChosen ? (
                  <Text
                    style={s.muted}
                  >
                    Choose a date
                    to see
                    available
                    times.
                  </Text>
                ) : (
                  <>
                    {availability.loading ? (
                      <>
                        <ActivityIndicator
                          accessibilityLabel="Checking availability"
                          color={
                            t.colors
                              .emerald
                          }
                        />

                        <Text
                          style={
                            s.muted
                          }
                        >
                          Checking
                          the
                          business
                          schedule…
                        </Text>
                      </>
                    ) : null}

                    {availability.error ? (
                      <>
                        <Notice
                          message={
                            availability.error
                          }
                          error
                        />

                        <Action
                          label="Retry availability"
                          secondary
                          disabled={
                            locked
                          }
                          onPress={() => {
                            setSelection(
                              (
                                previous,
                              ) => ({
                                ...previous,
                                time: "",
                              }),
                            );

                            setMessage(
                              "",
                            );

                            availability.refresh();
                          }}
                        />
                      </>
                    ) : null}

                    {availability.data
                      ?.code ===
                    "CLOSED" ? (
                      <Notice message="The business is closed on this date. Choose another date." />
                    ) : null}

                    {availability.data
                      ?.code ===
                    "NO_AVAILABILITY" ? (
                      <Notice message="No available times for this service on this date. Choose another date." />
                    ) : null}

                    {(!selectedTime ||
                      timeEditing) && (
                      <View
                        style={
                          s.row
                        }
                      >
                        {availability.data?.slots.map(
                          (
                            time,
                          ) => (
                            <Action
                              key={
                                time
                              }
                              label={timeLabel(
                                time,
                              )}
                              secondary
                              selected={
                                time ===
                                selectedTime
                              }
                              disabled={
                                locked
                              }
                              onPress={() => {
                                setSelection(
                                  (
                                    previous,
                                  ) => ({
                                    ...previous,
                                    time,
                                  }),
                                );

                                setTimeEditing(
                                  false,
                                );

                                setMessage(
                                  "",
                                );
                              }}
                            />
                          ),
                        )}
                      </View>
                    )}
                  </>
                )}
              </ComposerSection>
            </>
          )
        }
      />
    </KeyboardAvoidingView>
  );
}

const customerStyles =
  StyleSheet.create({
    searchLayout: {
      gap: t.space.md,
    },

    searchLayoutWide: {
      flexDirection: "row",
      alignItems:
        "flex-start",
    },

    searchColumn: {
      gap: t.space.md,
    },

    searchColumnWide: {
      flex: 1,
      minWidth: 0,
    },

    searchStatus: {
      minHeight:
        t.layout.touch,
      flexDirection: "row",
      alignItems: "center",
      gap: t.space.sm,
    },

    newCustomer: {
      gap: t.space.md,
    },

    newCustomerText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },

    matches: {
      backgroundColor:
        t.colors.surface,
      borderWidth:
        t.border,
      borderColor:
        t.colors.border,
      borderRadius:
        t.radius.md,
      overflow: "hidden",
    },

    matchesWide: {
      width: 300,
      flexShrink: 0,
    },

    matchesCompact: {
      width: "100%",
    },

    matchesHeader: {
      minHeight:
        t.layout.touch,
      paddingHorizontal:
        t.space.md,
      paddingVertical:
        t.space.sm,
      flexDirection: "row",
      alignItems: "center",
      justifyContent:
        "space-between",
      gap: t.space.sm,
    },

    matchesHeaderText: {
      flex: 1,
      minWidth: 0,
    },

    matchesTitle: {
      color:
        t.colors.text,
      fontSize:
        t.font.label,
      fontWeight: "600",
    },

    matchesSubtitle: {
      color:
        t.colors.muted,
      fontSize:
        t.font.caption,
      marginTop: 2,
    },

    matchesCount: {
      color:
        t.colors.muted,
      fontSize:
        t.font.caption,
      fontWeight: "600",
      flexShrink: 0,
    },

    match: {
      minHeight:
        t.layout.touch,
      paddingHorizontal:
        t.space.md,
      paddingVertical:
        t.space.sm,
      borderTopWidth:
        t.border,
      borderTopColor:
        t.colors.border,
      justifyContent:
        "center",
    },

    matchPressed: {
      backgroundColor:
        t.colors.neutral,
    },

    matchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space.sm,
    },

    matchIcon: {
      width: 30,
      height: 30,
      borderRadius:
        t.radius.sm,
      backgroundColor:
        t.colors.neutral,
      alignItems: "center",
      justifyContent:
        "center",
      flexShrink: 0,
    },

    matchText: {
      flex: 1,
      minWidth: 0,
    },

    matchName: {
      color:
        t.colors.text,
      fontSize:
        t.font.label,
      fontWeight: "600",
    },

    matchPhone: {
      color:
        t.colors.muted,
      fontSize:
        t.font.caption,
      marginTop: 2,
    },

    pagination: {
      padding: t.space.sm,
      borderTopWidth:
        t.border,
      borderTopColor:
        t.colors.border,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: t.space.sm,
    },
  });