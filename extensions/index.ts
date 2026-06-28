/**
 * pi-mixture-of-agents — extension entry.
 *
 * Registers:
 *   - the virtual `moa` provider (presets selectable as `moa/<preset>` in /model)
 *   - the `/moa` one-shot command
 *
 * Provider models are derived from moa.json presets. When a preset is the
 * active model, Pi calls the streamSimple facade, which fans out the preset's
 * references, appends their outputs at the tail of the last user message,
 * and calls the aggregator (the acting model) with the full tool schema.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TurnCache } from "../src/dedup";
import { loadConfig, resolvePreset, formatPresetList, upsertPreset, removePreset, saveConfig, normalizePreset } from "../src/config";
import { runPresetTurn } from "../src/engine";
import { makeCallSlot } from "../src/slots";
import { trimForReferences } from "../src/transcript";
import type { AdvisoryMessage } from "../src/transcript";
import type { NormalizedConfig } from "../src/types";
import { makeMoaStreamFacade, type CtxRef } from "../src/stream-facade";

const PROVIDER_NAME = "moa";

export default async function (pi: ExtensionAPI) {
	// Mutable holder for the live ExtensionContext. streamSimple has no ctx
	// in its signature, so the facade reads through this ref.
	const ctxRef: CtxRef = { current: null };
	const configState: { current: NormalizedConfig | null } = { current: null };
	const cache = new TurnCache();

	async function refreshConfig(): Promise<NormalizedConfig> {
		const cfg = await loadConfig();
		configState.current = cfg;
		return cfg;
	}

	// Register the virtual provider in the factory body so it is flushed
	// before the model catalog is built (and before session_start). The docs
	// are explicit: provider registrations queued in an async factory are
	// awaited; those queued in event handlers are not.
	const initialCfg = await refreshConfig();
	registerMoaProvider(pi, initialCfg, { ctxRef, cache, getConfig: () => configState.current ?? initialCfg });

	pi.on("session_start", async (_event, ctx) => {
		ctxRef.current = ctx;
		// Re-read on each session in case the user edited moa.json.
		await refreshConfig();
	});

	// New user turn boundary: clear the per-turn reference cache so refs run
	// fresh for the next turn. (Within a turn, tool-loop iterations reuse it.)
	pi.on("model_select", () => cache.clear());

	pi.registerCommand("moa", {
		description: "Run a one-shot Mixture of Agents pass over your prompt",
		handler: async (args, ctx) => {
			await runMoaCommand(args, ctx, pi);
		},
	});

	pi.registerCommand("moa-list", {
		description: "List configured MoA presets",
		handler: async (_args, ctx) => {
			const cfg = await loadConfig();
			ctx.ui.notify(formatPresetList(cfg), "info");
		},
	});

	pi.registerCommand("moa-configure", {
		description: "Create or update an MoA preset interactively",
		handler: async (args, ctx) => {
			await configurePreset(args.trim(), ctx);
		},
	});

	pi.registerCommand("moa-delete", {
		description: "Delete an MoA preset",
		handler: async (args, ctx) => {
			await deletePreset(args.trim(), ctx);
		},
	});

	function registerMoaProvider(
		pi: ExtensionAPI,
		cfg: NormalizedConfig,
		deps: { ctxRef: CtxRef; cache: TurnCache; getConfig: () => NormalizedConfig },
	) {
		const presetNames = Object.keys(cfg.presets);
		if (presetNames.length === 0) return;

		const onProgress = (text: string | undefined) => {
			const ctxNow = ctxRef.current as ExtensionContext | null;
			if (ctxNow && "ui" in ctxNow) {
				(ctxNow as unknown as { ui: { setStatus: (k: string, t: string | undefined) => void } })
					.ui.setStatus(PROVIDER_NAME, text);
			}
		};

		const streamSimple = makeMoaStreamFacade({
			getConfig: deps.getConfig,
			ctxRef: deps.ctxRef,
			cache: deps.cache,
			onProgress: onProgress as any,
		});

		pi.registerProvider(PROVIDER_NAME, {
			name: "Mixture of Agents",
			// api + baseUrl are REQUIRED for the model to surface in the picker,
			// even though streamSimple owns the actual request.
			api: "openai-completions",
			baseUrl: "https://moa.local/v1",
			apiKey: "moa-virtual-provider",
			models: presetNames.map((name) => ({
				id: name,
				name: `MoA: ${name}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: cfg.presets[name].max_tokens,
			})),
			streamSimple,
		});
	}
}

async function runMoaCommand(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const prompt = args.trim();
	const setStatus = (text: string | undefined) =>
		(ctx as unknown as { ui: { setStatus: (k: string, t: string | undefined) => void } })
			.ui.setStatus(PROVIDER_NAME, text);

	if (!prompt) {
		ctx.ui.notify("Usage: /moa <prompt>  (runs refs + aggregator once, model unchanged)", "info");
		return;
	}

	try {
		setStatus("loading config…");
		const config = await loadConfig();
		const preset = resolvePreset(config);
		if (!preset) {
			setStatus(undefined);
			ctx.ui.notify("No MoA preset configured. Create ~/.pi/agent/moa.json (see README).", "warning");
			return;
		}

		const transcript = readTranscript(ctx);
		const advisory: AdvisoryMessage[] = [
			...trimForReferences(transcript as Parameters<typeof trimForReferences>[0]),
			{ role: "user", content: [{ type: "text", text: prompt }] },
		];

		const call = makeCallSlot(ctx);

		setStatus(`running ${preset.reference_models.length} reference(s)…`);
		const { guidance } = await runPresetTurn({
			preset,
			advisory,
			call,
			mode: "oneshot",
			signal: (ctx as unknown as { signal?: AbortSignal }).signal,
			onProgress: (index, total, phase, label) => {
				if (phase === "ref-start") setStatus(`ref ${index + 1}/${total}: ${label}`);
				else if (phase === "aggregating") setStatus(`aggregating: ${label}`);
			},
		});
		setStatus(undefined);

		const message = guidance ? `${guidance}\n\n---\n\n${prompt}` : prompt;
		pi.sendUserMessage(message);
	} catch (e) {
		setStatus(undefined);
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`MoA failed: ${msg}`, "error");
	}
}

function readTranscript(ctx: ExtensionContext): unknown[] {
	const sm = ctx.sessionManager as unknown as {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const branch = typeof sm.getBranch === "function" ? sm.getBranch() : undefined;
	if (Array.isArray(branch)) return branch;
	const entries = typeof sm.getEntries === "function" ? sm.getEntries() : undefined;
	return Array.isArray(entries) ? entries : [];
}

/** Enumerate models available in the live catalog as "provider/model" strings. */
function availableModelLabels(ctx: ExtensionContext): string[] {
	const all = (ctx.modelRegistry as unknown as { getAll?: () => Array<{ provider: string; id: string }> }).getAll?.() ?? [];
	return all.map((m) => `${m.provider}/${m.id}`);
}

/** Pick a slot interactively. Returns undefined if the user cancels. */
async function pickSlot(
	ctx: ExtensionContext,
	title: string,
	options: string[],
): Promise<{ provider: string; model: string } | undefined> {
	if (options.length === 0) {
		ctx.ui.notify("No models available in the catalog.", "warning");
		return undefined;
	}
	const choice = await ctx.ui.select(title, options);
	if (!choice) return undefined;
	const idx = choice.indexOf("/");
	if (idx <= 0) return undefined;
	return { provider: choice.slice(0, idx), model: choice.slice(idx + 1) };
}

async function configurePreset(nameArg: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/moa-configure requires an interactive terminal.", "warning");
		return;
	}

	const name = nameArg || (await ctx.ui.input("Preset name", "default")) || "";
	if (!name) return;

	const raw = await loadConfigRaw();
	const existing = raw.presets?.[name];

	const options = availableModelLabels(ctx);

	// Aggregator first (required).
	const aggregator = await pickSlot(ctx, `Aggregator for "${name}"`, options);
	if (!aggregator) return;

	// References: ask how many, then pick each. Keep it simple (reviewer nit).
	const refCountStr = await ctx.ui.input(
		"Number of reference models (0 = aggregator alone)",
		String(existing?.reference_models?.length ?? 1),
	);
	const refCount = Math.max(0, Math.min(5, Number(refCountStr) || 0));

	const reference_models = [];
	for (let i = 0; i < refCount; i++) {
		const slot = await pickSlot(ctx, `Reference ${i + 1} for "${name}"`, options);
		if (!slot) break;
		reference_models.push(slot);
	}

	const enabled = await ctx.ui.confirm(`Enable "${name}"?`, "Disabled presets run the aggregator alone.");

	const preset = { reference_models, aggregator, enabled };
	try {
		normalizePreset(name, preset); // validate (incl. recursion guard) before saving
	} catch (e) {
		ctx.ui.notify(`Invalid preset: ${e instanceof Error ? e.message : String(e)}`, "error");
		return;
	}

	const updated = upsertPreset(raw, name, preset);
	await saveConfig(updated);
	ctx.ui.notify(`Saved preset "${name}". /reload or restart to pick up catalog changes.`, "info");
}

async function deletePreset(nameArg: string, ctx: ExtensionContext): Promise<void> {
	const raw = await loadConfigRaw();
	const names = Object.keys(raw.presets ?? {});
	if (names.length === 0) {
		ctx.ui.notify("No MoA presets to delete.", "info");
		return;
	}

	const name = nameArg || (ctx.hasUI ? await ctx.ui.select("Delete which preset?", names) : nameArg);
	if (!name || !raw.presets?.[name]) {
		if (name) ctx.ui.notify(`No preset named "${name}".`, "warning");
		return;
	}

	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(`Delete "${name}"?`, "This cannot be undone.");
		if (!ok) return;
	}

	const updated = removePreset(raw, name);
	await saveConfig(updated);
	ctx.ui.notify(`Deleted preset "${name}". /reload or restart to pick up catalog changes.`, "info");
}

/** Load the raw (un-normalized) config so upsert/remove preserve user formatting. */
async function loadConfigRaw() {
	const { readFile } = await import("node:fs/promises");
	const path = await import("node:path");
	const os = await import("node:os");
	const file = path.join(os.homedir(), ".pi", "agent", "moa.json");
	try {
		return JSON.parse(await readFile(file, "utf8")) as import("../src/types").MoaConfig;
	} catch {
		return { default_preset: "default", presets: {} } as import("../src/types").MoaConfig;
	}
}
