/**
 * pi-mixture-of-agents — extension entry.
 *
 * Mounts:
 *   - /moa one-shot command (Phase 3)
 *   - moa/test spike provider (Phase 0; Phase 4 replaces it with config-driven presets)
 *
 * The /moa command runs the engine once over the current transcript, in
 * one-shot mode (advisory guidance), and injects the result + the user's
 * prompt as a user message. It never switches the active model.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolvePreset } from "../src/config";
import { runPresetTurn } from "../src/engine";
import { makeCallSlot } from "../src/slots";
import { trimForReferences } from "../src/transcript";
import type { AdvisoryMessage } from "../src/transcript";
import { registerSpike } from "./spike-facade";

export default function (pi: ExtensionAPI) {
	// Phase 0 spike — keeps the streamSimple facade mechanism exercised.
	// Phase 4 will replace this with config-driven moa/<preset> models.
	registerSpike(pi);

	pi.registerCommand("moa", {
		description: "Run a one-shot Mixture of Agents pass over your prompt",
		handler: async (args, ctx) => {
			await runMoaCommand(args, ctx, pi);
		},
	});
}

async function runMoaCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const prompt = args.trim();
	if (!prompt) {
		ctx.ui.notify("Usage: /moa <prompt>  (runs refs + aggregator once, model unchanged)", "info");
		return;
	}

	const setStatus = (text: string | undefined) => ctx.ui.setStatus("moa", text);

	try {
		setStatus("loading config…");
		const config = await loadConfig();
		const preset = resolvePreset(config);
		if (!preset) {
			setStatus(undefined);
			ctx.ui.notify("No MoA preset configured. Create ~/.pi/agent/moa.json (see README).", "warning");
			return;
		}

		// Build the advisory view refs will see: trimmed transcript + this turn.
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
			signal: ctx.signal,
			onProgress: (index, total, phase, label) => {
				if (phase === "ref-start") setStatus(`ref ${index + 1}/${total}: ${label}`);
				else if (phase === "aggregating") setStatus(`aggregating: ${label}`);
			},
		});
		setStatus(undefined);

		// Inject guidance + the user's prompt as a user message. The active
		// model answers; MoA never switched it. guidance already carries the
		// [Mixture of Agents reference context] header (or is empty when no
		// usable refs, in which case we just send the prompt).
		const message = guidance ? `${guidance}\n\n---\n\n${prompt}` : prompt;
		pi.sendUserMessage(message);
	} catch (e) {
		setStatus(undefined);
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`MoA failed: ${msg}`, "error");
	}
}

/**
 * Read the current session branch as a list of {role, content} entries.
 * Falls back to an empty list if the session manager exposes nothing.
 */
function readTranscript(ctx: ExtensionCommandContext): unknown[] {
	const sm = ctx.sessionManager as unknown as {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const branch = typeof sm.getBranch === "function" ? sm.getBranch() : undefined;
	if (Array.isArray(branch)) return branch;
	const entries = typeof sm.getEntries === "function" ? sm.getEntries() : undefined;
	return Array.isArray(entries) ? entries : [];
}
