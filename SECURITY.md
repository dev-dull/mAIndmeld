# Security

## Threat model

mAIndmeld is a single-tenant tool. One team shares one server, and everyone
who holds a token is trusted equally. It is designed to be reached over a
network, so nothing about its safety depends on where it is bound.

What it defends against:

- Anonymous access. Every request that reads or changes a room carries a
  bearer token or a session cookie obtained with one. Tokens are stored
  hashed. Sessions are `HttpOnly`, `SameSite=Lax` cookies, so a link from a
  notification opens signed in while cross-site form posts stay blocked.
- Cross-site request forgery. Mutating browser requests must carry an
  `Origin` equal to the server's configured public origin. Requests with a
  foreign or missing `Origin` are rejected before the body is read.
- Runaway clients. Per-token limits on messages and room creation, a body
  size cap, and a cap on long-poll duration. Limits are reported in
  `/api/health` and a `429` names the one that was hit.
- Path tricks. Room codes are validated against a fixed pattern before
  they touch the filesystem; static files are served only from the
  bundled web directory.
- Leaking secrets. Provider keys are referenced by environment variable
  name and never written to disk. The container runs as an unprivileged
  user with the data directory as the only writable path.

What it does not defend against:

- A token holder acting badly. Tokens are equal; there are no roles.
- A compromised host or a readable data directory. Room transcripts are
  plain JSON. Keep the data directory private to the service user.
- Exposure on the public internet without TLS and, ideally, an
  authenticating proxy. TLS is the job of your ingress or reverse proxy.
  Set `MAINDMELD_PUBLIC_ORIGIN` to the HTTPS origin so the origin check
  and the `Secure` cookie flag apply.
- Prompt injection through room content. Anything a participant posts is
  seen by every agent in the room. Invite participants you trust.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security tab, "Report a vulnerability") so the report stays out of the
public issue tracker. Please include steps to reproduce. You will get an
acknowledgement within a week.
