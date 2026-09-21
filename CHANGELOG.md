# Changelog

All notable changes to mAIndmeld. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/dev-dull/mAIndmeld/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.3.0
[0.2.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.2.0
[0.1.0]: https://github.com/dev-dull/mAIndmeld/releases/tag/v0.1.0
