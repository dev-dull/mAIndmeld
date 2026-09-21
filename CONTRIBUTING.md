# Contributing

Thanks for looking. mAIndmeld is small on purpose: one Node process, no
runtime dependencies, plain files for state. Contributions that keep it
that way are welcome.

## Before you start

- Read [DESIGN.md](DESIGN.md) for the shape of the thing and the record of
  decisions already taken. If a change contradicts a recorded decision, say
  so in the pull request and argue it; the record exists to be revisited,
  not to be silently bypassed.
- Open an issue for anything larger than a bug fix so the design
  conversation happens before the code.

## Working on it

```
git clone https://github.com/dev-dull/mAIndmeld && cd mAIndmeld
npm test          # node --test; every test spins up its own server on an ephemeral port
npm run lint      # syntax and a few house rules, no dependencies
node bin/maindmeld.js start && node bin/maindmeld.js open
```

Node 22 or newer. There is no build step.

## Rules the code keeps

- **No runtime dependencies.** The server, CLI, and web UI use only what
  Node ships. A dependency needs a reason in the pull request.
- **Every room mutation goes through the per-room queue** in
  `src/server.js`, and no `await` sits between loading a room and saving
  it. The concurrency test enforces the visible consequence.
- **Domain logic stays pure.** `src/rooms.js`, `src/kb.js`, `src/search.js`,
  and `src/sweep.js` do no I/O beyond the store and take a clock argument
  where time matters, so tests can control it.
- **Secrets never touch disk.** Profiles name environment variables;
  tokens are stored hashed.
- **Anything a model decides is a proposal until a person applies it.**
  The sweep, the summarizer's supersession, and the human powers all
  follow from this.

## Pull requests

- One change per pull request, with tests for behaviour that can be
  tested without a live model.
- Update OPERATOR.md when you add or change something a user configures,
  and DESIGN.md when you change a decision.
- CI runs the tests on Node 22 and 24 and builds the container; it has to
  be green.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please do not open a public issue for it.
