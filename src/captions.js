// Automatic captions for uploaded images, from a vision-capable profile.
// Optional, and never in the way: the upload returns first, the caption is
// asked for in the background, and a failure leaves the person's caption
// untouched. The person's caption is still required; this adds a second
// line the summarizer and non-vision participants can use. Issue #4.

import { OpenAIChatClient, ModelError } from "./models.js";
import { Breaker } from "./summarize.js";

const PROMPT = "Describe this image for a meeting record in one sentence of at most 30 words: what it shows, including any figure, label, or error text that matters. No preamble.";

export function createCaptioner(config, log = () => {}) {
  const key = config.captions?.profile;
  if (!key) return null;
  const profile = config.profiles[key];
  if (!profile) throw new Error(`captions.profile names ${key}, which is not a configured profile`);
  const client = new OpenAIChatClient({ baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv, model: profile.model, timeoutMs: profile.timeoutMs, extra: profile.extra });
  const breaker = new Breaker();
  const stats = { calls: 0, failures: 0 };

  return {
    profile: key,
    model: profile.model,
    state: () => ({ profile: key, model: profile.model, ...stats, breaker: breaker.state() }),
    /** One sentence, or null when the endpoint is down, paused, or answers nonsense. */
    async caption(buffer, type) {
      if (breaker.isOpen()) return null;
      stats.calls += 1;
      const dataUri = `data:${type};base64,${buffer.toString("base64")}`;
      try {
        const { text } = await client.complete(
          [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUri } }] }],
          { maxTokens: 80, temperature: 0 },
        );
        const line = text.split("\n").find((l) => l.trim()) || "";
        const clean = line.trim().replace(/^caption:\s*/i, "").slice(0, 300);
        if (clean.length < 3) throw new ModelError(`${profile.model}: caption too short`);
        breaker.success();
        return clean;
      } catch (error) {
        stats.failures += 1;
        const pause = breaker.failure({ rateLimited: error.status === 429 });
        log(`caption via ${key}: ${error.message}${pause ? `; pausing captions for ${Math.round(pause / 60000)} min` : ""}`);
        return null;
      }
    },
  };
}
