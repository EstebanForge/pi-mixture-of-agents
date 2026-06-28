import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Phase 0 spike — minimal.
 *
 * Goal: prove the registerProvider + streamSimple facade mechanism works
 * for MoA. This spike hardcodes one reference and one aggregator and does
 * NOT yet trim transcripts, dedup, or fan out. It exists to answer:
 *
 *   1. Does context.tools reach streamSimple?  (tool schema survival)
 *   2. Can we call complete() for a ref inside streamSimple using a ctx
 *      captured at session_start?
 *   3. Can we delegate the final answer to an aggregator and emit it
 *      through createAssistantMessageEventStream such that a tool call
 *      round-trips back to the agent loop?
 *
 * See the v0.1 spike exit criteria in the module comment block above.
 */

// --- HARDCODED SPIKE SLOTSS (will move to moa.json in Phase 1) -------------
// Slots must reference models present in THIS environment's catalog.
const REF_SLOT = { provider: "google", model: "gemini-2.5-flash" } as const;
const AGG_SLOT = { provider: "google", model: "gemini-2.5-flash" } as const;
const PROVIDER_NAME = "moa";
const MODEL_ID = "test";

// --- module-scope ctx stash (streamSimple signature has no ctx) -----------
// --- module-scope ctx stash (streamSimple signature has no ctx) -----------
let ctxStash: ExtensionContext | null = null;
function getCtx(): ExtensionContext {
  if (!ctxStash) throw new Error("moa-spike: ctx not captured yet");
  return ctxStash;
}

export function registerSpike(pi: ExtensionAPI) {
  // Capture ctx for use inside streamSimple (no ctx in its signature).
  pi.on("session_start", (_event, ctx) => {
    ctxStash = ctx;
  });
  pi.on("session_shutdown", () => {
    // do not null it: handler may still be mid-flight; next session overwrites.
  });

  pi.registerProvider(PROVIDER_NAME, {
    name: "Mixture of Agents (spike)",
    api: "openai-completions",
    baseUrl: "https://moa.local/v1",
    apiKey: "moa-spike-nokey",
    models: [
      {
        id: MODEL_ID,
        name: "MoA Spike (1 ref → agg)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: moaSpikeStream,
  });

  pi.registerCommand("moa-spike-status", {
    description: "Report whether the MoA spike captured ctx",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`moa-spike ctx captured: ${!!ctxStash}`, "info");
    },
  });
}

// --- the facade -----------------------------------------------------------
function moaSpikeStream(model: any, context: any, options?: any) {
  // Stream created synchronously at top (imports are now top-level ESM).
  const stream = createAssistantMessageEventStream();

  const ctx = getCtx();
  const log = (msg: string) => ctx.ui.setStatus("moa-spike", msg);

  (async () => {
    // SPIKE OBSERVABILITY — Phase 0 criteria 1 & 2:
    const toolCount = Array.isArray(context.tools) ? context.tools.length : 0;
    const msgCount = Array.isArray(context.messages) ? context.messages.length : 0;
    log(`enter msgs=${msgCount} tools=${toolCount}`);

    // Build a trimmed advisory view for the reference: text-only, no tools,
    // no system prompt. (Phase 2 will formalize this in transcript.ts.)
    const advisoryMessages = trimToAdvisory(context.messages);

    // --- REFERENCE CALL -----------------------------------------------------
    let refText = "";
    try {
      const refModel = getModel(REF_SLOT.provider, REF_SLOT.model);
      if (!refModel) throw new Error(`model ${REF_SLOT.provider}/${REF_SLOT.model} not in catalog`);
      const refAuth = await ctx.modelRegistry.getApiKeyAndHeaders(refModel);
      if (refAuth.ok === false) {
        throw new Error(refAuth.error);
      }
      // Note: getApiKeyAndHeaders may return ok:true with no key in some
      // modes; pi-ai/compat's complete() also does env-key injection, so we
      // pass whatever we have and let it fill the rest.
      log("running ref…");
      const refResp = await complete(
        refModel,
        { messages: advisoryMessages },
        { apiKey: refAuth.apiKey, headers: refAuth.headers, env: refAuth.env, signal: options?.signal },
      );
      refText = refResp.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n") || "(empty reference)";
      log("ref done");
    } catch (e: any) {
      // Per Hermes: a reference failure does not abort the turn.
      refText = `[reference failed: ${e?.message ?? String(e)}]`;
      log("ref FAILED (continuing)");
    }

    // --- AGGREGATOR CALL ----------------------------------------------------
    // Spike: aggregator IS the acting model. We append the ref output as a
    // private block at the tail of the last user message (Hermes trick) and
    // call the aggregator with the FULL tool schema from context.tools.
    const aggMessages = appendRefContext(context.messages, refText);

    let aggResp: any;
    try {
      const aggModel = getModel(AGG_SLOT.provider, AGG_SLOT.model);
      if (!aggModel) throw new Error(`aggregator model ${AGG_SLOT.provider}/${AGG_SLOT.model} not in catalog`);
      const aggAuth = await ctx.modelRegistry.getApiKeyAndHeaders(aggModel);
      if (aggAuth.ok === false) {
        throw new Error(aggAuth.error);
      }
      log("running aggregator…");
      aggResp = await complete(
        aggModel,
        { messages: aggMessages, tools: context.tools },
        { apiKey: aggAuth.apiKey, headers: aggAuth.headers, env: aggAuth.env, signal: options?.signal },
      );
    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      log("aggregator FAILED");
      emitError(stream, model, errMsg);
      return;
    }

    // --- EMIT aggregator result through the stream -------------------------
    // v1 non-streaming emission: start → content events → done → end.
    emitAssistant(stream, aggResp, model);
    log("done");
  })().catch((e) => {
    emitError(stream, model, e?.message ?? String(e));
  });

  return stream;
}

// --- helpers --------------------------------------------------------------

/** Strip to user/assistant text only — no system, no tool blocks. */
function trimToAdvisory(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages ?? []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (text.trim()) out.push({ role: m.role, content: [{ type: "text", text }] });
  }
  return out;
}

/** Append the ref output as a tail block on the last user message. */
function appendRefContext(messages: any[], refText: string): any[] {
  const copy = messages.map((m: any) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "user") {
      const block = { type: "text", text: `\n\n[Mixture of Agents reference context]\n${refText}` };
      copy[i].content = Array.isArray(copy[i].content) ? [...copy[i].content, block] : [block];
      break;
    }
  }
  return copy;
}

function emitAssistant(stream: any, aggResp: any, model: any) {
  const partial = { ...aggResp, provider: PROVIDER_NAME, model: MODEL_ID };
  stream.push({ type: "start", partial });
  // emit text + toolcall content events
  let idx = 0;
  for (const c of aggResp.content ?? []) {
    if (c.type === "text") {
      stream.push({ type: "text_start", contentIndex: idx, partial });
      stream.push({ type: "text_delta", contentIndex: idx, delta: c.text, partial });
      stream.push({ type: "text_end", contentIndex: idx, content: c.text, partial });
    } else if (c.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: idx, partial });
      stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: c, partial });
    }
    idx++;
  }
  stream.push({ type: "done", reason: aggResp.stopReason ?? "stop", message: partial });
  stream.end(partial);
}

function emitError(stream: any, _model: any, message: string) {
  const err: any = {
    role: "assistant",
    content: [{ type: "text", text: `[moa-spike error] ${message}` }],
    provider: PROVIDER_NAME,
    model: MODEL_ID,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: err });
  stream.end(err);
}

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
