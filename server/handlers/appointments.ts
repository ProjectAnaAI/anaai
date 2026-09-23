import {
  createClient,
} from "@supabase/supabase-js";

import {
  resolveBusinessContext,
} from "@/lib/business-context";
import {
  actionMessage,
  actionReceipt,
  deliverActionNotification,
  fingerprint,
  isUuid,
  schedulingIntent,
} from "@/lib/appointment-actions";

const schedulingErrors: Record<
  string,
  [number, string]
> = {
  IDEMPOTENCY_CONFLICT: [
    409,
    "This request key belongs to a different action.",
  ],

  INVALID_TRANSITION: [
    409,
    "This appointment cannot make that status transition.",
  ],

  UNAUTHORIZED: [
    401,
    "Please log in again.",
  ],

  FORBIDDEN: [
    403,
    "Business access is not available.",
  ],

  INVALID_CUSTOMER: [
    400,
    "Customer reference is not available for this business.",
  ],

  INVALID_SERVICE: [
    400,
    "Select an active service available for this business.",
  ],

  INVALID_DURATION: [
    400,
    "The service does not have a valid duration.",
  ],

  INVALID_SCHEDULE: [
    400,
    "Select a valid appointment date and time.",
  ],

  INVALID_HOURS: [
    400,
    "Business hours are not configured correctly.",
  ],

  CLOSED: [
    409,
    "The business is closed on the selected day.",
  ],

  OUTSIDE_HOURS: [
    409,
    "The appointment must fit within business hours.",
  ],

  SOURCE_DATE_CHANGED: [
    409,
    "This appointment was moved by another request. Refresh and try again.",
  ],

  SLOT_CONFLICT: [
    409,
    "That time is no longer available. Please choose another time.",
  ],

  INVALID_EXISTING_SCHEDULE: [
    409,
    "The calendar contains an appointment that cannot be safely checked.",
  ],

  APPOINTMENT_NOT_FOUND: [
    404,
    "Appointment not found.",
  ],

  TERMINAL_APPOINTMENT: [
    409,
    "Only Booked or Confirmed appointments can be rescheduled.",
  ],
};

export async function POST(
  request: Request
) {
  return handle(
    request,
    true
  );
}

export async function PATCH(
  request: Request
) {
  return handle(
    request,
    false
  );
}

async function handle(
  request: Request,
  creating: boolean
) {
  try {
    const token =
      request.headers
        .get("authorization")
        ?.match(
          /^Bearer (.+)$/
        )?.[1]
        ?.trim();

    if (!token) {
      return Response.json(
        {
          error:
            "Please log in again.",
        },
        {
          status: 401,
        }
      );
    }

    const context =
      await resolveBusinessContext({
        accessToken: token,

        requestedBusinessId:
          request.headers
            .get(
              "x-anaai-business-id"
            )
            ?.trim() || null,
      });

    if (!context.success) {
      return Response.json(
        {
          error:
            context.status >= 500
              ? "Unable to load appointment context."
              : context.error,
        },
        {
          status:
            context.status,
        }
      );
    }

    const businessId =
      context.context.businessId;

    const db = createClient(
      process.env
        .NEXT_PUBLIC_SUPABASE_URL!,
      process.env
        .NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Authorization:
              `Bearer ${token}`,
          },
        },

        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    let body: Record<
      string,
      unknown
    >;

    try {
      const parsed =
        await request.json();

      if (
        !parsed ||
        typeof parsed !==
          "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error();
      }

      body = parsed as Record<
        string,
        unknown
      >;
    } catch {
      return Response.json(
        {
          error:
            "Invalid request.",
        },
        {
          status: 400,
        }
      );
    }

    const key =
      request.headers.get(
        "idempotency-key"
      );

    if (
      !isUuid(key) ||
      (!creating &&
        !isUuid(
          body.appointmentId
        ))
    ) {
      return Response.json(
        {
          error:
            "A valid request key and appointment reference are required.",
        },
        {
          status: 400,
        }
      );
    }

    const scheduling = [
      "customerId",
      "customer_id",
      "serviceId",
      "service_id",
      "appointmentDate",
      "appointmentTime",
    ].some((keyName) =>
      Object.hasOwn(
        body,
        keyName
      )
    );

    let action: string;
    let name: string;

    let params: Record<
      string,
      unknown
    >;

    let intent:
      | Record<
          string,
          unknown
        >
      | undefined;

    if (
      creating ||
      scheduling
    ) {
      for (const [
        camel,
        snake,
      ] of [
        [
          "customerId",
          "customer_id",
        ],
        [
          "serviceId",
          "service_id",
        ],
      ]) {
        if (
          !isUuid(
            body[camel] ??
              body[snake]
          ) ||
          (body[camel] !==
            undefined &&
            body[snake] !==
              undefined &&
            String(
              body[camel]
            ).toLowerCase() !==
              String(
                body[snake]
              ).toLowerCase())
        ) {
          return Response.json(
            {
              error:
                "Select valid customer and service references.",
            },
            {
              status: 400,
            }
          );
        }
      }

      if (
        body.status !==
          undefined ||
        (body.notes != null &&
          typeof body.notes !==
            "string")
      ) {
        return Response.json(
          {
            error:
              "Invalid scheduling request.",
          },
          {
            status: 400,
          }
        );
      }

      try {
        intent =
          schedulingIntent({
            customer_id:
              body.customerId ??
              body.customer_id,

            service_id:
              body.serviceId ??
              body.service_id,

            appointment_id:
              creating
                ? null
                : body.appointmentId,

            date:
              body.appointmentDate,

            time:
              body.appointmentTime,

            notes: body.notes,
          });
      } catch {
        return Response.json(
          {
            error:
              "Select a valid schedule.",
          },
          {
            status: 400,
          }
        );
      }

      action =
        creating
          ? "book"
          : "reschedule";

      const operation =
        creating
          ? "manual_book"
          : "reschedule";

      name =
        "schedule_appointment_idempotent_business";

      params = {
        p_business_id:
          businessId,

        p_idempotency_key:
          key,

        p_operation:
          operation,

        p_request:
          intent,

        p_request_fingerprint:
          fingerprint({
            businessId,
            operation,
            intent,
          }),
      };
    } else {
      const status =
        body.status;

      if (
        ![
          "Confirmed",
          "Cancelled",
          "Completed",
        ].includes(
          String(status)
        ) ||
        Object.keys(body).some(
          (keyName) =>
            ![
              "appointmentId",
              "status",
              "notificationType",
            ].includes(keyName)
        )
      ) {
        return Response.json(
          {
            error:
              "Unsupported appointment action.",
          },
          {
            status: 400,
          }
        );
      }

      if (
        status ===
        "Confirmed"
      ) {
        action = "confirm";
      } else if (
        status ===
        "Cancelled"
      ) {
        action = "cancel";
      } else {
        action = "complete";
      }

      name =
        `${action}_appointment_atomic_business`;

      params = {
        p_business_id:
          businessId,

        p_appointment_id:
          body.appointmentId,

        p_idempotency_key:
          key,

        p_request_fingerprint:
          fingerprint({
            businessId,
            action,

            appointmentId:
              body.appointmentId,
          }),
      };
    }

    const {
      data,
      error,
    } = await db.rpc(
      name,
      params
    );

    const receipt =
      !error &&
      actionReceipt(
        data,
        businessId,
        action,
        creating
          ? undefined
          : String(
              body.appointmentId
            )
      );

    if (!receipt) {
      const failure =
        !error &&
        data?.success ===
          false &&
        Object.hasOwn(
          schedulingErrors,
          data.code
        ) &&
        schedulingErrors[
          data.code
        ];

      const [
        status,
        message,
      ] =
        failure || [
          500,
          "The action could not be verified. Retry with the same request key.",
        ];

      return Response.json(
        {
          success: false,
          error: message,
        },
        {
          status,
        }
      );
    }

    if (
      intent &&
      (
        receipt.appointment
          .customer_id !==
          intent.customer_id ||
        receipt.appointment
          .service_id !==
          intent.service_id ||
        receipt.appointment
          .appointment_date !==
          intent.date ||
        !receipt.appointment
          .appointment_time ||
        schedulingIntent({
          ...intent,

          time:
            receipt.appointment
              .appointment_time,
        }).time !==
          intent.time
      )
    ) {
      return Response.json(
        {
          success: false,

          error:
            "The action could not be verified. Retry with the same request key.",
        },
        {
          status: 500,
        }
      );
    }

    /*
     * Completion intentionally has no customer SMS.
     * Existing book/reschedule/confirm/cancel behavior is unchanged.
     */
    const smsSent =
      action === "complete"
        ? false
        : await deliverActionNotification(
            db,
            businessId,
            receipt.action_id
          );

    return Response.json({
      success: true,
      appointment:
        receipt.appointment,
      receipt,

      message:
        actionMessage(
          receipt
        ),

      sms_sent:
        smsSent,

      notification_type:
        action,

      sms_error: null,
    });
  } catch {
    console.error(
      "Appointment action request failed."
    );

    return Response.json(
      {
        error:
          "The action could not be verified. Retry with the same request key.",
      },
      {
        status: 500,
      }
    );
  }
}