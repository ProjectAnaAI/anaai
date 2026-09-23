import express, { type ErrorRequestHandler } from "express";

import * as ai from "./handlers/ai";
import * as appointments from "./handlers/appointments";
import * as currentBusiness from "./handlers/current-business";
import * as onboarding from "./handlers/onboarding";
import * as voice from "./handlers/voice";
import * as voiceTrial from "./handlers/voice-trial";
import { webHandler } from "./http";

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

  // Keep the raw body: handlers parse JSON or Twilio form data themselves.
  api.use(express.raw({ type: () => true, limit: "1mb" }));

  api.post("/ai", webHandler(ai.POST));

  api.post("/appointments", webHandler(appointments.POST));
  api.patch("/appointments", webHandler(appointments.PATCH));

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

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json({ success: false, error: "Request body is too large." });
      return;
    }

    console.error("AnaAI API request failed:", error);
    res.status(500).json({ success: false, error: "Unexpected server error." });
  };

  app.use(errorHandler);

  return app;
}
