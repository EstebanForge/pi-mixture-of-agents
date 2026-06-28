/**
 * Session-mode stream facade for pi-mixture-of-agents.
 *
 * This is the direct analogue of Hermes's MoAChatCompletions.create(): a
 * streamSimple that owns the request lifecycle. When a `moa/<preset>` model
 * is selected, Pi calls this function with the full context (messages +
 * tools). We:
 *
 *   1. resolve the preset by model.id
 *   2. trim the transcript for references (text-only advisory view)
 *   3. dedup: if the advisory signature matches the last turn, reuse refs
 *   4. fan out references in parallel (failure-tolerant)
 *   5. aggregate refs into guidance (session mode: aggregator IS acting model)
 *   6. append guidance to the TAIL of the last user message (cache-safe)
 *   7. call the aggregator with the full tool schema
 *   8. re-emit the aggregator response through AssistantMessageEventStream
 *
 * Tool calls round-trip because we emit toolcall_* events; Pi's agent loop
 * executes them and calls streamSimple again on the next iteration with the
 * tool results appended. Dedup ensures refs don't re-run on that iteration.
 *
 * ctx is captured at session_start in index.ts and passed via a mutable ref,
 * because streamSimple's signature has no ExtensionContext parameter.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TurnCache, signature } from "./dedup";
import { runReferences } from "./engine";
import { GUIDANCE_HEADER, hasUsableGuidance } from "./prompts";
import { callAggregator, makeCallSlot } from "./slots";
import { trimForReferences } from "./transcript";
import type { NormalizedConfig, NormalizedPreset, ReferenceResult, SlotContext } from "./types";

/** Mutable holder for the live ExtensionContext, updated on session_start. */
export type CtxRef = { current: SlotContext | null };

/** Status relay: optional callback for fan-out progress (UIsetStatus). */
export type OnProgress = (text: string) => void;

export interface FacadeDeps {
	/** Live config (re-read or stashed by caller). */
	getConfig: () => NormalizedConfig;
	/** Live ctx, captured at session_start. */
	ctxRef: CtxRef;
	/** Per-instance turn cache (reset on model_select). */
	cache: TurnCache;
	/** Optional status relay. */
	onProgress?: OnProgress;
}

/**
 * Build a streamSimple function bound to the given deps.
 * The returned function matches pi-ai's streamSimple contract.
 */
export function makeMoaStreamFacade(deps: FacadeDeps) {
	return function moaStream(model: any, context: any, options?: any): any {
		// Stream must be created synchronously before any await.
		const stream = createAssistantMessageEventStream();

		(async () => {
			const presetName = String(model?.id ?? "");
			const config = deps.getConfig();
			const preset = config.presets[presetName];
			if (!preset) {
				emitError(stream, `unknown MoA preset: ${presetName}`);
				return;
			}
			const ctx = deps.ctxRef.current;
			if (!ctx) {
				emitError(stream, "ctx not captured (session_start not fired)");
				return;
			}

			const signal: AbortSignal | undefined = options?.signal;
			const messages: any[] = Array.isArray(context?.messages) ? context.messages : [];
			const tools = context?.tools;

			try {
				const finalMessages = await buildAggregatorMessages({
					preset, presetName, messages, ctx, cache: deps.cache, signal,
					onProgress: deps.onProgress,
				});

				deps.onProgress?.(`aggregating: ${preset.aggregator.provider}/${preset.aggregator.model}`);
				const resp = await callAggregator(preset.aggregator, ctx, {
					messages: finalMessages,
					tools,
					temperature: preset.aggregator_temperature,
					maxTokens: preset.max_tokens,
					signal,
				});

				emitAssistant(stream, resp, model);
				deps.onProgress?.(undefined as any);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				emitError(stream, msg);
				deps.onProgress?.(undefined as any);
			}
		})();

		return stream;
	};
}

/**
 * Run refs (with dedup) and return a messages array with a reference-context
 * block appended at the tail of the last user message. The single aggregator
 * call in the facade then answers using that context.
 *
 * Session mode (mirrors Hermes MoAChatCompletions.create): the aggregator IS
 * the acting model. We do NOT call it twice; we just inject the reference
 * text as background and let the one aggregator call in moaStream answer.
 *
 * When the preset is disabled or no usable refs exist, messages are returned
 * unchanged so the aggregator runs alone.
 */
async function buildAggregatorMessages(args: {
	preset: NormalizedPreset;
	presetName: string;
	messages: any[];
	ctx: SlotContext;
	cache: TurnCache;
	signal?: AbortSignal;
	onProgress?: OnProgress;
}): Promise<any[]> {
	const { preset, presetName, messages, ctx, cache, signal, onProgress } = args;

	if (!preset.enabled) return messages;

	const advisory = trimForReferences(messages);
	const key = signature(advisory, presetName, preset.reference_models);

	const cached = cache.get(key);
	let refs: ReferenceResult[];
	if (cached) {
		refs = cached;
	} else {
		const instruction = advisory
			.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.map((c) => c.text).join("\n")}`)
			.join("\n\n");
		const call = makeCallSlot(ctx);
		refs = await runReferences({
			slots: preset.reference_models,
			instruction,
			call,
			temperature: preset.reference_temperature,
			maxTokens: preset.max_tokens,
			signal,
			onProgress: (i, total, phase, label) => {
				if (phase === "ref-start") onProgress?.(`ref ${i + 1}/${total}: ${label}`);
			},
		});
		cache.set(key, refs);
	}

	if (!hasUsableGuidance(refs)) return messages;

	return appendGuidanceTail(messages, renderRefContext(refs));
}

/** Render reference outputs (with failures) as a labelled guidance block. */
function renderRefContext(refs: readonly ReferenceResult[]): string {
	const body = refs
		.map((r, i) => r.ok ? `[reference ${i + 1}]\n${r.text}` : `[reference ${i + 1}]\n[reference failed: ${r.error}]`)
		.join("\n\n");
	return `${GUIDANCE_HEADER}\n${body}`;
}

/** Append the guidance block at the tail of the last user message (cache-safe). */
function appendGuidanceTail(messages: any[], guidance: string): any[] {
	if (!guidance.trim()) return messages;
	const copy = messages.map((m) => ({
		...m,
		content: Array.isArray(m.content) ? [...m.content] : m.content,
	}));
	for (let i = copy.length - 1; i >= 0; i--) {
		if (copy[i].role === "user") {
			const block = { type: "text", text: `\n\n${guidance}` };
			copy[i].content = Array.isArray(copy[i].content) ? [...copy[i].content, block] : [block];
			break;
		}
	}
	return copy;
}

/** Emit a successful AssistantMessage through the stream (v1: non-streaming). */
function emitAssistant(stream: any, resp: any, model: any) {
	const partial = {
		...resp,
		provider: "moa",
		model: String(model?.id ?? "moa"),
	};
	stream.push({ type: "start", partial });
	let idx = 0;
	for (const c of resp.content ?? []) {
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
	stream.push({ type: "done", reason: resp.stopReason ?? "stop", message: partial });
	stream.end(partial);
}

/** Emit an error event and close the stream. */
function emitError(stream: any, message: string) {
	const err: any = {
		role: "assistant",
		content: [{ type: "text", text: `[moa error] ${message}` }],
		provider: "moa",
		model: "moa",
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
