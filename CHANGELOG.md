# Changelog

All notable changes to mAIndmeld. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-09-25

### Added
- Tokens may carry an expiry and a room scope; the server mints one per
  harness launch, refuses it outside its room, revokes it when the launch
  or the room ends, and sweeps expired records (#29, first step of #36).
- Harness launches (#30): `POST /api/rooms/:code/launches` and
  `room_invite kind: "harness"` ask a runner to start a harness into a
  room; runners subscribe to `GET /api/runner/events`, claim launches for
  a room-scoped token, and report how they ended; the room narrates
  requested, started, joined, exited, failed, timed out, cancelled; the
  scheduler times out launches that never join and cancels them when the
  room closes; `GET /api/runners` and the health endpoint list runners.
- The runner (#31): `maindmeld runner --config runner.json` subscribes to
  a server, claims launches for the harnesses it lists, fills a prompt
  template, starts the command with a room-scoped token in its
  environment, caps its log locally, kills it on cancel or timeout, and
  reaps leftovers on restart. Commands come only from the runner's file.
- Harness templates (#32): `templates/harness/` holds MCP configurations,
  a prompt template, and `runner.json` entries for Claude Code, OpenCode,
  Gemini CLI, Codex, Hermes, and Pi, with a table of which are verified;
  Claude Code is, from a real launch. Placeholders `{prompt}` and
  `{templates}`; a `null` in a harness's `env` removes a variable.
- Room page (#33): an Invite box lists the harnesses online runners offer
  and launches one; launch states show under the participants and update
  live.
- Runner packaging (#34): `Dockerfile.runner` builds `maindmeld-runner`
  with Claude Code and OpenCode preinstalled, published by CI beside the
  server image; `compose.yaml` gains a `runner` profile; the Kubernetes
  base deploys a runner with its own ConfigMap and Secret. Unprivileged,
  no Docker socket; the socket is an opt-in for the runner only.
- Docs (#35): the runner in DESIGN.md (scope, section 7.4, decision 16),
  OPERATOR.md (setup, config, lifecycle, troubleshooting), README, and
  the Kubernetes README.

### Fixed
- A model participant that gets a 413, or a 400 naming a length or token
  limit, now halves its transcript window and retries at once instead of
  counting a failure toward a ten-minute pause; the window creeps back by
  one message per reply. Profiles take `max_prompt_chars`; health shows the
  effective window; single messages over 4,000 characters are clipped in
  the model's view (#28).

## [0.4.4] - 2026-09-25

### Fixed
- A model participant that gets a 413, or a 400 naming a length or token
  limit, now halves its transcript window and retries at once instead of
  counting a failure toward a ten-minute pause; the window creeps back by
  one message per reply. Profiles take `max_prompt_chars`; health shows the
  effective window; single messages over 4,000 characters are clipped in
  the model's view (#28).

## [0.4.3] - 2026-09-22

### Changed
- Lobby cards show a memo icon beside the status badge instead of the
  note's id; the id stays in the tooltip.

## [0.4.2] - 2026-09-22

### Changed
- Room page, from the review in room MM-SCLF: each message is a bordered
  card with its image in a figure and a labelled caption bar (#18); voter
  tags are colour-coded pills, panel boxes carry a strip saying whether
  they act on the room or on you, and human-only controls carry a mark
  (#19); the "You were called" box comes first and loud, and the objective
  banner is labelled (#20).

## [0.4.1] - 2026-09-22

### Fixed
- Lobby cards with a note link rendered split apart: the card was an anchor
  holding another anchor. The title is now the link, the note a second one,
  and clicking the rest of the card still opens the room (#14).
- Automatic captions use the profile's own token budget instead of a small
  fixed one, which a thinking model could exhaust before answering.

### Changed
- Lobby cards have one anatomy: title row with the status badge, meta row,
  participants row; participants wrap and are never truncated (#15).
- Lobby sections carry a coloured left rail and heading, the create form
  matches the cards, and every colour comes from a theme token (#16).
- `GET /api/health` reports each profile's `vision` flag.

## [0.4.0] - 2026-09-22

### Added
- Image attachments (issue #2): `POST /api/rooms/:code/attachments` stores
  one PNG, JPEG, WebP, or GIF beside the room file, checked by its bytes and
  capped per file and per room; messages and `room_send` take an
  `attachment_id` and `caption`; the bytes are served to participants or by
  a signed five-minute link; uploads never sent on a message are cleaned up.
  Models and the summarizer see `[image: caption]` until the follow-up
  issues land.
- The room page attaches images (issue #3): a picker beside the composer,
  or paste one in; a preview strip with a caption field; the upload happens
  on send, so a failure leaves the text and image in the composer; images
  render inline with the caption, and open full size in a new tab.
- Captions (issue #4): a caption of at least three characters is required
  with every image, since it is all that non-vision participants and the
  summarizer see. `captions.profile` names a vision-capable profile that
  adds a one-sentence automatic caption in the background, never blocking
  the upload and never replacing the person's caption.
- Vision for model participants (issue #5): a profile with `vision: true`
  gets the newest four images from others as data-URI image parts with
  metadata stripped, within 1 MB and `image_max_px`; anything else, and
  every other profile, gets the caption line. A rejected image part is an
  ordinary failure.
- The summarizer sees captions only (issue #6): the envelope renders an
  image as `[image: caption]` with any generated description, and the
  prompt asks for images to be cited by caption, never by id or link.

## [0.3.0] - 2026-09-21

### Added
- `kb_search`: keyword scoring over decisions, blended with embeddings from
  any OpenAI-compatible endpoint when a profile is configured.
- Join-time injection: every join and new room returns up to five relevant
  active decisions, and agents are told to search before proposing.
- The human brief: why a person was called and what is needed, in the API,
  the room page, and every notifier payload.
- The sweep: proposes conflicting decisions on a topic (rules first, a
  model second) and topic merges; a person applies or rejects each
  proposal; the scheduler runs it weekly.
- A logo, favicon, and touch icon built from Noto Emoji.
- OPERATOR.md, and a README written for first-time readers.

### Changed
- Undeclared decision topics are promoted with a warning instead of
  failing note validation.
- Summaries credit a close to the motion's proposer.

## [0.2.0] - 2026-09-20

### Added
- The summarizer contract with three adapters (an OpenAI-compatible
  profile, headless Claude Code, or any executable), a validation retry,
  and a circuit breaker.
- The knowledge store: meeting notes, decision files with stable ids, a
  JSON Lines mirror, raw transcripts, a topic vocabulary, and a generated
  index; close-time supersession; resummarize.
- The `closing` state, ingest ledger, pending retries, and a human's
  "close without a note".
- Kubernetes manifests split into a base and per-ingress overlays.

## [0.1.0] - 2026-09-20

### Added
- The room server with a web UI, CLI, and MCP over HTTP.
- Model participants from OpenAI-compatible profiles.
- Motions to close and to call a human, with the tie-to-human rule,
  delivery-tracked vote windows, and human override, wait, hold,
  acknowledge, and dismiss.
- Guardrails: open-room cap per creator, abandoned rooms, per-profile
  latency statistics, an hourly call cap.
- Notifiers: webhook, ntfy, desktop.
- Docker image, compose demo, CI, security policy.

[Unreleased]: https://github.com/dev-dull/mAIndmeld/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.5.0
[0.4.4]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.4.4
[0.4.3]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.4.3
[0.4.2]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.4.2
[0.4.1]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.4.1
[0.4.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.4.0
[0.3.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.3.0
[0.2.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.2.0
[0.1.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.1.0
