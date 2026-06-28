/**
 * Slot resolution + model calls for pi-mixture-of-agents.
 *
 * A slot is a {provider, model} pair. `callSlot` resolves it through Pi's
 * model registry (credentials + headers) and calls pi-ai's `complete()`.
 *
 * The engine takes a `CallSlot` as a dependency so its core stays pure and
 * unit-testable without touching the network. This module is the only file
 * that imports pi-ai/compat and the model registry.
 */
import { complete, getModel as _getModel } from "@earendil-works/pi-ai/compat";
import type { CallSlot, Slot, SlotContext } from "./types";

/**
 * pi-ai's getModel is generic over KnownProvider + keyof MODELS[T], which
 * collapses to `never` when the provider is a runtime string. Slots are
 * user-configured, so we intentionally take the loose path and resolve at
 * runtime; a catalog miss is handled as a thrown error below.
 */
const getModel = _getModel as unknown as (
	provider: string,
	modelId: string,
) => ReturnType<typeof _getModel> | undefined;

/** Message shape accepted by pi-ai complete(): role + content array. */
type PiMessage = { role: string; content: unknown };

/**
 * Build a `CallSlot` bound to a Pi ExtensionContext.
 *
 * Returns the model's text response. Throws on any failure (the engine
 * catches per-slot and folds the error into the reference results, mirroring
 * Hermes's failure tolerance).
 *
 * Recursion guard (runtime safety net, mirrors moa_loop.py:142): a slot whose
 * provider is the virtual `moa` provider is skipped with a labelled note
 * instead of being called.
 */
export function makeCallSlot(ctx: SlotContext): CallSlot {
	return async (slot, instruction, opts) => {
		if (slot.provider.toLowerCase() === "moa") {
			throw new Error("[skipped: MoA presets cannot recursively reference MoA]");
		}

		const model = getModel(slot.provider, slot.model);
		if (!model) {
			throw new Error(`model ${slot.provider}/${slot.model} not in catalog`);
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const resp = await complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				temperature: opts.temperature,
				maxTokens: opts.maxTokens,
				signal: opts.signal,
			},
		);

		const text = resp.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!text) throw new Error("empty response");
		return text;
	};
}

/**
 * Call the aggregator with a full message list (including the tail-injected
 * guidance) and a tool schema. Returns the raw AssistantMessage so the
 * facade can re-emit its content (text + tool calls) through the stream.
 */
export async function callAggregator(
	slot: Slot,
	ctx: SlotContext,
	args: {
		messages: PiMessage[];
		tools?: unknown;
		systemPrompt?: string;
		temperature?: number;
		maxTokens?: number;
		signal?: AbortSignal;
	},
) {
	if (slot.provider.toLowerCase() === "moa") {
		throw new Error("[skipped: MoA aggregator cannot be a MoA preset]");
	}
	const model = getModel(slot.provider, slot.model);
	if (!model) throw new Error(`aggregator model ${slot.provider}/${slot.model} not in catalog`);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(auth.error);

	// `messages` / `tools` come from the Pi Context shape; the `as never` is a
	// pragmatic bridge across pi-ai's generic Message/Tool types. The fields
	// themselves are structurally compatible at runtime.
	return complete(
		model,
		{
			messages: args.messages as never,
			tools: args.tools as never,
			systemPrompt: args.systemPrompt,
		} as never,
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			temperature: args.temperature,
			maxTokens: args.maxTokens,
			signal: args.signal,
		},
	);
}
