import * as timeReports from "./handlers/time-reports";
import * as audit from "./handlers/audit";
import * as timeIssues from "./handlers/time-issues";
import * as timesheets from "./handlers/timesheets";
import * as working from "./handlers/working";
import express, { type ErrorRequestHandler } from "express";

import * as ai from "./handlers/ai";
import * as appointments from "./handlers/appointments";
import * as appointmentReads from "./handlers/appointment-reads";
import * as businesses from "./handlers/businesses";
import * as todayAppointments from "./handlers/today-appointments";
import * as currentBusiness from "./handlers/current-business";
import * as customers from "./handlers/customers";
import * as onboarding from "./handlers/onboarding";
import * as services from "./handlers/services";
import * as team from "./handlers/team";
import * as devices from "./handlers/devices";
import * as timeClock from "./handlers/time-clock";
import * as voice from "./handlers/voice";
import * as voiceTrial from "./handlers/voice-trial";
import { webHandler } from "./http";
import { apiCors } from "./cors";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("etag", false);
  // Requests arrive through the Next.js rewrite proxy or a local reverse proxy.
  app.set("trust proxy", "loopback");

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(apiCors());

  // Keep the raw body: handlers parse JSON or Twilio form data themselves.
  api.use(express.raw({ type: () => true, limit: "1mb" }));

  api.post("/ai", webHandler(ai.POST));

  api.post("/appointments", webHandler(appointments.POST));
  api.patch("/appointments", webHandler(appointments.PATCH));
  api.get("/appointments/day", webHandler(appointmentReads.DAY));
  api.get(
    "/appointments/availability",
    webHandler(appointmentReads.AVAILABILITY),
  );
  api.get("/customers", webHandler(appointmentReads.CUSTOMERS));
  api.get("/services", webHandler(appointmentReads.SERVICES));

  // Native CRM and catalog. Fixed paths are registered before :id.
  api.get("/customers/directory", webHandler(customers.DIRECTORY));
  api.get("/customers/:id", webHandler(customers.DETAIL));
  api.post("/customers", webHandler(customers.CREATE));
  api.patch("/customers/:id", webHandler(customers.UPDATE));

  api.get("/services/catalog", webHandler(services.CATALOG));
  api.post("/services", webHandler(services.CREATE));
  api.patch("/services/:id", webHandler(services.UPDATE));

  // M04 account-managed devices and separate opaque employee identity.
  api.get("/devices", webHandler(devices.DIRECTORY));
  api.post("/devices", webHandler(devices.REGISTER));
  api.post("/devices/:id", webHandler(devices.REVOKE));
  api.post("/device/pin", webHandler(devices.PIN));
  api.post("/employee-session/validate", webHandler(devices.VALIDATE));
  api.post("/employee-session/lock", webHandler(devices.LOCK));

  // M04 Team administration.
  api.get("/team", webHandler(team.DIRECTORY));
  api.post("/team", webHandler(team.CREATE));
  api.patch("/team/:id", webHandler(team.UPDATE));
  api.post("/team/:id/pin", webHandler(team.RESET_PIN));

  api.get("/management/timesheets", webHandler(timesheets.DIRECTORY));
  api.get("/management/timesheets/:employeeId", webHandler(timesheets.GET));
  // M06 Slice 4: immutable time corrections (backend only).
  api.post("/management/timesheets/:employeeId/corrections/preview", webHandler(timesheets.PREVIEW_CORRECTION));
  api.post("/management/timesheets/:employeeId/corrections", webHandler(timesheets.COMMIT_CORRECTION));
  api.get("/management/time-reports", webHandler(timeReports.GET));
  api.post("/management/time-reports/export", webHandler(timeReports.EXPORT));
  api.get("/management/audit", webHandler(audit.GET));
  api.get("/management/time-issues", webHandler(timeIssues.GET));
  api.get("/management/time-issues/:issueId", webHandler(timeIssues.DETAIL));
  api.post("/management/time-issues/:issueId/resolve", webHandler(timeIssues.RESOLVE));
  api.get("/management/working", webHandler(working.GET));

  // M05 Time Clock + My Time: device credential + employee session only.
  api.get("/time-clock", webHandler(timeClock.STATE));
  api.post("/time-clock/clock-in", webHandler(timeClock.CLOCK_IN));
  api.post("/time-clock/break-start", webHandler(timeClock.BREAK_START));
  api.post("/time-clock/break-end", webHandler(timeClock.BREAK_END));
  api.post("/time-clock/clock-out", webHandler(timeClock.CLOCK_OUT));
  api.get("/my-time", webHandler(timeClock.MY_TIME));
  api.post("/my-time/issues", webHandler(timeClock.REPORT_ISSUE));

  api.get("/appointments", webHandler(todayAppointments.GET));
  api.get("/businesses", webHandler(businesses.GET));

  api.get("/current-business", webHandler(currentBusiness.GET));

  api.post("/onboarding", webHandler(onboarding.POST));

  api.get("/voice", webHandler(voice.GET));
  api.post("/voice", webHandler(voice.POST));

  api.get("/voice/trial", webHandler(voiceTrial.GET));
  api.post("/voice/trial", webHandler(voiceTrial.POST));

  api.use((_req, res) => {
    res.status(404).json({ success: false, error: "Not found." });
  });

  app.use("/api", api);

  const errorHandler: ErrorRequestHandler = (
    error,
    _req,
    res,
    _next,
  ) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json({
        success: false,
        error: "Request body is too large.",
      });
      return;
    }

    console.error("AnaAI API request failed:", error);
    res.status(500).json({
      success: false,
      error: "Unexpected server error.",
    });
  };

  app.use(errorHandler);

  return app;
}