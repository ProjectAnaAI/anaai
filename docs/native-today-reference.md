# Authoritative Today workspace implementation

Reference: `/Users/ayutacharya/Downloads/ZUDE/iPad/Today/workspace-container.png`. User's accompanying brief controls implementation; screenshot names/times/content are illustrative, not data requirements.

## Before-edit mismatch inventory

- Reference header is a compact horizontal band: business, divider, Today/date, search, right CTA. Current header stacks business/page/date with an oversized Today title.
- Reference uses near-black timeline and compact light rows; current timeline is white with separated table-like rows.
- Reference places time plus duration in the left column; current left column splits oversized time/AM-PM, with duration under service.
- Reference rows are approximately 58–60pt with restrained rounded borders and gaps; current rows are around 80pt without discrete surfaces.
- Reference NOW divider is dot/current time/NOW/continuation; current divider is green NOW/time on white.
- Reference Up Next is a compact bordered warm panel with relative timing and appointment time on one line; current section is a large open vertical stack with a separate action.
- Reference right rail is a compact warm surface. Current rail has generous spacing; future operational slots must remain extensible without fabricated content.
- Reference New Appointment is orange; current shared default button is green. Booking itself should remain green.
- Current navigation exposes Web/Later/Phase 2 metadata, now explicitly prohibited. Typed capabilities and full IA must remain; unavailable destinations stay disabled without engineering labels.
- Reference open-until, hours range, employee timer, next-slot grid, inbox and activity lack corresponding authoritative Today contracts. Omit or provide truthful availability guidance, never copy these examples.

## Preservation boundary

Existing Today hook → bearer API → tenant-verified appointment read remains unchanged. Business contract contains name/timezone/role, not hours or shift data. Existing clock provides business-local date/minutes. Existing pure helpers provide chronological order, current/past classification and nearest upcoming nonterminal appointment. Row selection continues to the real appointment inspector; New Appointment continues to the existing progressive composer. Full corrected navigation and canonical R5 asset slot remain.

The screenshot is 960×768 and omits navigation. At the requested 1024×768 app viewport, preserve the existing 100pt navigation rail and adapt the reference inside the remaining 924pt workspace; do not remove navigation to reproduce its crop. Slightly larger controls and higher text contrast preserve touch/accessibility requirements.
