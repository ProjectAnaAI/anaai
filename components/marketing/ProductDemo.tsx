import { ArrowRight, CalendarDays, Check, Phone, Users } from "lucide-react";

type DemoMedia = { src: string; poster: string; captions: string };
/** Supply an owned video and WebVTT captions together when real product footage is available. */
export function ProductDemo({ media }: { media?: DemoMedia }) {
  return (
    <section className="marketing-section demo-section" id="demo">
      <div className="section-heading">
        <div>
          <p className="eyebrow">From conversation to a clear next step</p>
          <h2>
            See AnaAI run
            <br />
            the front desk.
          </h2>
        </div>
        <p>
          A caller needs a time. AnaAI checks your availability. Your business
          has one less thing to interrupt the day.
        </p>
      </div>
      {media ? (
        <video
          className="product-video"
          controls
          preload="none"
          poster={media.poster}
          playsInline
        >
          <source src={media.src} type="video/mp4" />
          <track
            kind="captions"
            src={media.captions}
            srcLang="en"
            label="English"
            default
          />
          Your browser does not support video playback.
        </video>
      ) : (
        <div
          className="product-poster"
          aria-label="Illustrated product walkthrough, fictional appointment data"
        >
          <div className="poster-top">
            <span>AnaAI / A front-desk moment</span>
            <span>Illustrated walkthrough</span>
          </div>
          <div className="poster-scene">
            <div className="poster-conversation">
              <Phone size={23} />
              <p>
                “Could I come in
                <br />
                Thursday afternoon?”
              </p>
              <span>
                A simple request.
                <br />A useful outcome.
              </span>
            </div>
            <ArrowRight className="poster-arrow" />
            <div className="poster-calendar">
              <div>
                <CalendarDays size={18} />
                <strong>Thursday</strong>
                <span>Example schedule</span>
              </div>
              <p>
                14:00 <span />
              </p>
              <div className="poster-booking">
                <span>14:30</span>
                <div>
                  <strong>Sarah Mitchell</strong>
                  <small>Cut & finish · 45 min</small>
                </div>
                <Check size={18} />
              </div>
              <p>
                15:00 <span />
              </p>
              <p>
                15:30 <span />
              </p>
              <div className="poster-customer">
                <Users size={16} />
                Customer details, together with the booking
              </div>
            </div>
          </div>
          <div className="poster-bottom">
            <span>
              01 / Phone call <i />
              02 / Availability <i />
              03 / Appointment
            </span>
            <a href="#product">
              Explore the interactive example <ArrowRight size={16} />
            </a>
          </div>
        </div>
      )}
      <p className="media-note">
        {media
          ? "AnaAI product demonstration."
          : "An original interface illustration, not a customer recording. Product video is not available yet."}
      </p>
    </section>
  );
}
