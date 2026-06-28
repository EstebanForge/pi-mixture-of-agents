# @estebanforge/pi-mixture-of-agents

**Mixture of Agents** for Pi. Registers a virtual `moa` provider (presets selectable in `/model`) plus a `/moa` one-shot command. Each preset fans out N reference models in parallel over a trimmed transcript, an aggregator synthesizes their outputs into private guidance appended at the message tail, and the aggregator becomes the acting model with the full tool schema intact.

Ports the MoA technique from [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`agent/moa_loop.py`). Not an LLM; an orchestration layer over models you already have configured.

## Install

```
pi install npm:@estebanforge/pi-mixture-of-agents
```

Then `/reload` in Pi (or restart), and pick a preset from `/model` under the `Mixture of Agents` provider, use `/moa <prompt>` for a one-shot, or manage presets with `/moa-list` / `/moa-configure` / `/moa-delete`.

Reference and aggregator models must already be configured in Pi (`~/.pi/agent/models.json` or a provider with credentials). The extension does not ship API keys.

## Commands

| Command | Description |
| --- | --- |
| `/moa <prompt>` | One-shot pass: runs refs + aggregator once over your prompt, injects guidance as a user message, and leaves the active model unchanged |
| `/moa-list` | Print every configured preset (refs, aggregator, default marker, enabled flag) |
| `/moa-configure [name]` | Interactively create or update a preset: pick aggregator, 0-5 references from the live catalog, and the enabled toggle |
| `/moa-delete [name]` | Confirm and remove a preset; `default_preset` falls back to the next remaining |

> Slash commands only dispatch in an interactive Pi session (not in `pi -p` print mode). Selecting `moa/<preset>` from `/model` works in every mode.

## How it works

```
┌─ Reference fan-out (parallel, cheap) ──────────────────┐
│  ref A           ref B           ...                    │
│  ↑ no tool schema, no system prompt, trimmed transcript │
└───────────────┬────────────────────────────────────────┘
                │ outputs collected (order preserved, failures tolerated)
                ▼
┌─ Aggregator (single model call) ───────────────────────┐
│  synthesizes refs into guidance → wrapped in           │
│  [Mixture of Agents reference context] block           │
└───────────────┬────────────────────────────────────────┘
                │ appended at TAIL of last user message (cache-safe)
                ▼
┌─ Normal Pi agent loop (aggregator = acting model) ─────┐
│  full tool schema intact → tools, interrupts, turns     │
└────────────────────────────────────────────────────────┘
```

Per iteration when a MoA preset is the active model:

1. **Trim** the transcript to user/assistant text only (no system prompt, no tool schemas, no tool-call/result blocks) so reference calls stay cheap and avoid strict-provider rejections.
2. **Fan out** the reference models in parallel (`Promise.all`, order preserved). Per-reference failures are tolerated; the error string is folded into the guidance and the turn continues with the survivors.
3. **Aggregate** the references into a private guidance block. One-shot mode (`/moa`) synthesizes *advisory* guidance ("do not answer the user directly"); session mode treats the aggregator as the acting model that answers or calls tools directly.
4. **Inject** the guidance at the **tail** of the last user message. The stable prefix (system prompt + history) stays byte-stable, so provider prompt caching is preserved.

## Guardrails

- **Recursion blocked** — reference and aggregator slots cannot be `moa:<preset>`. Rejected at config load and runtime-skipped with a note (mirrors `moa_loop.py:142`).
- **Per-turn dedup** — references are keyed by `sha256(advisory_messages) + preset + slot labels`. On retry within the same user turn (e.g. a tool-loop iteration), the advisory view is unchanged, so cached outputs are reused and the fan-out is skipped (mirrors `moa_loop.py:347-369`).
- **`enabled: false`** — per-preset off switch: references are cleared and the aggregator runs alone, exactly as if you had selected it as a plain model.
- **Abort-aware** — `options.signal` threads into every nested reference and aggregator call; Esc cancels in-flight fan-out.

## Configuration

Presets live in `~/.pi/agent/moa.json` (project override at `.pi/moa.json`):

```json
{
  "default_preset": "default",
  "presets": {
    "default": {
      "reference_models": [
        { "provider": "google", "model": "gemini-2.5-flash" },
        { "provider": "deepseek", "model": "deepseek-v4-pro" }
      ],
      "aggregator": { "provider": "claude-bridge", "model": "claude-opus-4-8" },
      "reference_temperature": 0.6,
      "aggregator_temperature": 0.4,
      "max_tokens": 4096,
      "enabled": true
    }
  }
}
```

Slots are explicit `{provider, model}` pairs, so you can mix providers and use multiple models from the same provider. Use `/moa-configure` to build a preset interactively from the models already in your catalog.

## v1 limitations

- **Aggregator is non-streaming.** Reference calls are non-streaming by design; the aggregator is also called via `complete()` and emitted through a one-shot `AssistantMessageEventStream`. You see the full answer when the aggregator finishes, not token-by-token. Cross-provider streaming re-emission is planned for v2.
- **Token cost.** A single model iteration can involve N reference calls plus the aggregator call. Mitigate with cheap reference models and per-turn dedup.
- **No weighted voting or routing.** All configured references always run; aggregation is pure textual synthesis. (Hermes does the same.)

## Why

Hermes's own docs report that on their HermesBench, a two-model MoA preset outscores either component model alone: MoA **0.8202** vs `claude-opus-4.8` at 0.7607 vs `gpt-5.5` at 0.7412. The takeaway is that aggregating a second perspective lifts quality on hard tasks rather than just averaging the two. (These are Hermes's published numbers, not benchmarks we ran; see their [Mixture of Agents docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents).)

## License

MIT
