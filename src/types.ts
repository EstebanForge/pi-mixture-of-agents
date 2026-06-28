/**
 * Config types for pi-mixture-of-agents.
 *
 * Mirrors the Hermes `moa` config shape (https://github.com/NousResearch/hermes-agent,
 * hermes_cli/config.py:2093) adapted to JSON. A preset is an explicit list of
 * reference slots plus one aggregator slot; slots are {provider, model} pairs
 * so presets can mix providers and use multiple models from the same provider.
 */

/** A single model endpoint: provider name + model id, both as Pi knows them. */
export interface Slot {
	provider: string;
	model: string;
}

/**
 * A named MoA recipe.
 *
 * - `reference_models` fan out in parallel over a trimmed transcript.
 * - `aggregator` synthesizes their outputs and is the acting model.
 * - `enabled: false` clears the references and lets the aggregator run alone.
 */
export interface Preset {
	reference_models: Slot[];
	aggregator: Slot;
	/** Sampling temperature for reference calls. Default 0.6. */
	reference_temperature?: number;
	/** Sampling temperature for the aggregator call. Default 0.4. */
	aggregator_temperature?: number;
	/** Max output tokens for both reference and aggregator calls. Default 4096. */
	max_tokens?: number;
	/** Per-preset off switch: when false, references are skipped. Default true. */
	enabled?: boolean;
}

/** Top-level config file shape (~/.pi/agent/moa.json or .pi/moa.json). */
export interface MoaConfig {
	default_preset?: string;
	presets?: Record<string, Preset>;
}

/** A Preset with all optional fields filled in. */
export interface NormalizedPreset extends Preset {
	reference_models: Slot[];
	aggregator: Slot;
	reference_temperature: number;
	aggregator_temperature: number;
	max_tokens: number;
	enabled: boolean;
}

/** Result of normalizing the whole config: resolved defaults, guaranteed shape. */
export interface NormalizedConfig {
	default_preset: string;
	presets: Record<string, NormalizedPreset>;
}

/** Error thrown when a preset references itself recursively. */
export class RecursionError extends Error {
	constructor(slot: Slot) {
		super(`MoA presets cannot reference the "moa" provider (recursion): ${slot.provider}/${slot.model}`);
		this.name = "RecursionError";
	}
}

/** Error thrown when a preset is structurally invalid (missing fields, etc). */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}
