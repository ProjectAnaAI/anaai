export function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`brand ${inverse ? "brand-inverse" : ""}`}>
      <span>
        Ana<span className="brand-ai">AI</span>
      </span>
      <span className="brand-endorsement">
        by <b>ZUDE</b>
      </span>
    </span>
  );
}

export function VoiceLine({ animated = false }: { animated?: boolean }) {
  return (
    <span
      className={`voice-line ${animated ? "voice-line-active" : ""}`}
      aria-hidden="true"
    >
      {[8, 15, 24, 12, 32, 42, 21, 36, 18, 48, 30, 16, 38, 25, 12, 20, 8].map(
        (height, index) => (
          <i
            key={index}
            style={{ height, animationDelay: `${index * -0.09}s` }}
          />
        ),
      )}
    </span>
  );
}
