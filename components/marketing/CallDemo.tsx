"use client";

import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Pause,
  Phone,
  Play,
  RotateCcw,
} from "lucide-react";
import { VoiceLine } from "@/components/brand/Brand";

const scenarios = [
  {
    name: "Book a visit",
    service: "Cut & finish",
    result: "Appointment booked",
    steps: [
      [
        "Incoming call",
        "Caller",
        "Hi, I’d like to book a haircut for Thursday.",
      ],
      ["Listening", "AnaAI", "Of course. Would you like a cut and finish?"],
      ["Understanding", "Caller", "Yes please, sometime in the afternoon."],
      [
        "Checking availability",
        "AnaAI",
        "Thursday at 2:30 PM is available. Would you like that?",
      ],
      [
        "Confirming details",
        "Caller",
        "Perfect. Please book it under Sarah Mitchell.",
      ],
      [
        "Appointment booked",
        "AnaAI",
        "You’re booked for Thursday at 2:30 PM. We’ll see you then.",
      ],
    ],
  },
  {
    name: "Change a plan",
    service: "Cut & finish",
    result: "Appointment rescheduled",
    steps: [
      ["Incoming call", "Caller", "Can I move my Thursday appointment?"],
      ["Listening", "AnaAI", "I can help you find another time."],
      [
        "Finding the appointment",
        "Caller",
        "It’s Sarah Mitchell, a cut and finish.",
      ],
      [
        "Checking availability",
        "AnaAI",
        "Friday at 11 AM is available. Does that work?",
      ],
      ["Confirming the change", "Caller", "Yes, please move it to Friday."],
      [
        "Appointment rescheduled",
        "AnaAI",
        "Your appointment is now Friday at 11 AM.",
      ],
    ],
  },
  {
    name: "Speak to a person",
    service: "Human handoff",
    result: "Transfer requested",
    steps: [
      ["Incoming call", "Caller", "Hello, I have a question about my visit."],
      ["Listening", "AnaAI", "Hi. How can I help?"],
      [
        "Understanding",
        "Caller",
        "I’d prefer to speak with someone at the business.",
      ],
      ["Preparing a handoff", "AnaAI", "Of course, I can try to connect you."],
      ["Confirming the request", "Caller", "Thank you."],
      [
        "Transfer requested",
        "AnaAI",
        "Please hold while I try to connect you.",
      ],
    ],
  },
];

export function CallDemo() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReduced(media.matches);
      setPlaying(!media.matches);
      if (media.matches) setStep(5);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!playing || reduced) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setStep((current) => (current + 1) % 6);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [playing, reduced, scenarioIndex]);
  const scenario = scenarios[scenarioIndex];
  const current = scenario.steps[step];
  return (
    <div className="call-demo">
      <div
        className="demo-scenarios"
        role="group"
        aria-label="Example call scenario"
      >
        {scenarios.map((item, index) => (
          <button
            key={item.name}
            aria-pressed={index === scenarioIndex}
            onClick={() => {
              setScenarioIndex(index);
              setStep(reduced ? 5 : 0);
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      <div className="call-stage">
        <div className="call-top">
          <span className="demo-label">
            Fictional call · interactive example
          </span>
          <Phone size={17} />
        </div>
        <div className="caller">
          <span className="caller-avatar">SM</span>
          <div>
            <h3>Sarah Mitchell</h3>
            <p>
              Calling Juniper Studio{" "}
              <span>· 00:{String(4 + step * 5).padStart(2, "0")}</span>
            </p>
          </div>
        </div>
        <div className="wave-stage">
          <VoiceLine animated={playing && !reduced} />
          <span>{current[0]}</span>
        </div>
        <div className="demo-transcript" aria-live="off">
          <p className="transcript-speaker">{current[1]}</p>
          <p key={`${scenarioIndex}-${step}`} className="transcript-line">
            “{current[2]}”
          </p>
        </div>
        <div className={`demo-result ${step === 5 ? "is-complete" : ""}`}>
          <span className="result-icon">
            {step === 5 ? <Check size={19} /> : <ChevronRight size={19} />}
          </span>
          <div>
            <strong>{step === 5 ? scenario.result : scenario.service}</strong>
            <span>
              {scenarioIndex === 2
                ? "A person when it matters"
                : scenarioIndex === 1
                  ? "Friday · 11:00 AM"
                  : "Thursday · 2:30 PM"}
            </span>
          </div>
          <span className="result-tag">
            {step === 5 ? "Confirmed in this example" : "Example request"}
          </span>
        </div>
        <div className="demo-controls">
          <div className="demo-progress" aria-label={`Step ${step + 1} of 6`}>
            {scenario.steps.map((item, index) => (
              <button
                key={item[0]}
                aria-label={`Show ${item[0]}`}
                aria-pressed={index === step}
                onClick={() => {
                  setPlaying(false);
                  setStep(index);
                }}
              >
                <span className={index <= step ? "filled" : ""} />
              </button>
            ))}
          </div>
          <button
            className="demo-control"
            aria-label="Restart example"
            onClick={() => setStep(0)}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="demo-control"
            aria-label={
              playing
                ? "Pause example"
                : reduced
                  ? "Next example step"
                  : "Play example"
            }
            onClick={() =>
              reduced
                ? setStep((current) => (current + 1) % 6)
                : setPlaying((current) => !current)
            }
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </div>
      </div>
      <p className="demo-footnote">
        A simulated conversation. No real call or booking is made.
      </p>
    </div>
  );
}
