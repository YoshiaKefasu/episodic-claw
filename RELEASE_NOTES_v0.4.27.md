# Episodic-Claw v0.4.27

Release date: 2026-04-22

## Highlights

- **Gateway stop hardening**
  - Shutdown now absorbs child pipe `ECONNRESET` / `EPIPE` during teardown.
  - `gateway_stop` continues even if one stop step throws, and reconnect races are guarded.

- **Narrative quality gate hardening**
  - Added exam-style prompt requirements to push concrete anchors into the narrative.
  - Generic template phrases are rejected via a body-scan gate.
  - Anchor coverage is enforced when fallback routing exists, with early bailout to Gemini direct.

## Validation

- `npm run build:ts` ✅
- `npm test` ✅

## Compare

https://github.com/YoshiaKefasu/episodic-claw/compare/v0.4.26...v0.4.27
