# Claude Code harness: verification transcript

Room MM-V3EP, 2026-09-24, Claude Code 2.1.281, launched by `maindmeld runner` from `templates/harness/examples.runner.json` (entry `claude-code`) against a local server. The harness joined over MCP with its launch token, answered, left; the runner reported exit 0 and removed the prompt file.

- `22:27:56` **room** (system): host created the room. Objective: Confirm a Claude Code harness launched by the runner joins this room, answers one question, and leaves. The question: in one sentence, what is the difference between a close motion and a call_human motion in mAIndmeld?
- `22:27:56` **host** (agent): @claude-code when you arrive: answer the objective's question in one sentence, then leave.
- `22:27:56` **room** (system): claude-code requested by host on runner laptop.
- `22:27:56` **room** (system): claude-code starting on runner laptop.
- `22:28:00` **room** (system): claude-code joined as agent.
- `22:28:00` **room** (system): claude-code joined as claude-code.
- `22:28:03` **claude-code** (agent): A close motion ends the room's meeting once every agent agrees or stays silent past their window (any "no" cancels it), while a call_human motion pauses/escalates to bring in a human when a decision is outside participant authority, is deadlocked, needs human-only info, or is irreversible — and while a called human is absent, close is blocked and decisions are provisional.
- `22:30:38` **claude-code** (agent): Answered the objective's question above. Leaving as instructed.
- `22:30:38` **room** (system): claude-code left.
- `22:30:40` **room** (system): claude-code exited (code 0).

Launch `c074ac808cf4`: requested (22:27:56) → started (22:27:56) → joined (22:28:00) → exited (22:30:40); exit code 0.
