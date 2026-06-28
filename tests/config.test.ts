import { describe, expect, it } from "vitest";
import {
	DEFAULTS,
	assertNotRecursive,
	defaultConfig,
	loadConfig,
	normalizeConfig,
	normalizePreset,
	resolvePreset,
} from "../src/config";
import { ConfigError, type MoaConfig, type Preset, RecursionError } from "../src/types";

const validPreset: Preset = {
	reference_models: [{ provider: "google", model: "gemini-2.5-flash" }],
	aggregator: { provider: "claude-bridge", model: "claude-opus-4-8" },
};

describe("assertNotRecursive", () => {
	it("accepts a non-moa slot", () => {
		expect(() => assertNotRecursive({ provider: "google", model: "x" })).not.toThrow();
	});

	it("rejects a moa provider (case-insensitive)", () => {
		expect(() => assertNotRecursive({ provider: "moa", model: "default" })).toThrow(RecursionError);
		expect(() => assertNotRecursive({ provider: "MOA", model: "default" })).toThrow(RecursionError);
	});
});

describe("normalizePreset", () => {
	it("applies defaults to a minimal preset", () => {
		const p = normalizePreset("p", validPreset);
		expect(p.reference_temperature).toBe(DEFAULTS.reference_temperature);
		expect(p.aggregator_temperature).toBe(DEFAULTS.aggregator_temperature);
		expect(p.max_tokens).toBe(DEFAULTS.max_tokens);
		expect(p.enabled).toBe(DEFAULTS.enabled);
	});

	it("preserves explicit values", () => {
		const p = normalizePreset("p", { ...validPreset, enabled: false, max_tokens: 8192 });
		expect(p.enabled).toBe(false);
		expect(p.max_tokens).toBe(8192);
	});

	it("rejects a recursive reference slot", () => {
		expect(() =>
			normalizePreset("p", {
				...validPreset,
				reference_models: [{ provider: "moa", model: "x" }],
			}),
		).toThrow(RecursionError);
	});

	it("rejects a recursive aggregator slot", () => {
		expect(() =>
			normalizePreset("p", { ...validPreset, aggregator: { provider: "moa", model: "x" } }),
		).toThrow(RecursionError);
	});

	it("rejects a missing aggregator", () => {
		expect(() => normalizePreset("p", { reference_models: [] } as unknown as Preset)).toThrow(ConfigError);
	});

	it("rejects a slot missing model", () => {
		expect(() =>
			normalizePreset("p", { ...validPreset, aggregator: { provider: "google" } as Preset["aggregator"] }),
		).toThrow(ConfigError);
	});

	it("accepts an empty reference_models list (enabled:false case)", () => {
		const p = normalizePreset("p", { reference_models: [], aggregator: validPreset.aggregator });
		expect(p.reference_models).toEqual([]);
	});
});

describe("normalizeConfig", () => {
	it("returns empty presets for null/undefined input", () => {
		expect(normalizeConfig(null)).toEqual({ default_preset: "default", presets: {} });
		expect(normalizeConfig(undefined)).toEqual({ default_preset: "default", presets: {} });
	});

	it("normalizes a full config and resolves default_preset", () => {
		const cfg = normalizeConfig({ default_preset: "review", presets: { review: validPreset, default: validPreset } });
		expect(cfg.default_preset).toBe("review");
		expect(Object.keys(cfg.presets).sort()).toEqual(["default", "review"]);
	});

	it("falls back to the first preset when default_preset is unknown", () => {
		const cfg = normalizeConfig({ default_preset: "ghost", presets: { review: validPreset } });
		expect(cfg.default_preset).toBe("review");
	});

	it("folds a legacy flat shape into a single default preset", () => {
		const flat = { aggregator: validPreset.aggregator, reference_models: validPreset.reference_models } as unknown as MoaConfig;
		const cfg = normalizeConfig(flat);
		expect(cfg.default_preset).toBe("default");
		expect(cfg.presets.default).toBeDefined();
		expect(cfg.presets.default.aggregator).toEqual(validPreset.aggregator);
	});
});

describe("resolvePreset", () => {
	const cfg = normalizeConfig({ presets: { default: validPreset, review: { ...validPreset, enabled: false } } });

	it("returns the named preset when it exists", () => {
		expect(resolvePreset(cfg, "review")?.enabled).toBe(false);
	});

	it("falls back to default when name is missing or unknown", () => {
		expect(resolvePreset(cfg, undefined)?.enabled).toBe(true);
		expect(resolvePreset(cfg, "ghost")?.enabled).toBe(true);
	});
});

describe("defaultConfig", () => {
	it("ships a disabled default preset with placeholder slots", () => {
		const cfg = defaultConfig();
		expect(cfg.default_preset).toBe("default");
		const p = cfg.presets!.default;
		expect(p.enabled).toBe(false);
		// Placeholder slots must be present and obviously non-real.
		expect(p.aggregator.provider).toContain("<");
		expect(p.reference_models[0].provider).toContain("<");
	});

	it("normalizes cleanly (placeholders pass validation, only recursion is blocked)", () => {
		expect(() => normalizeConfig(defaultConfig())).not.toThrow();
	});
});

describe("loadConfig (merge)", () => {
	it("merges user and project presets with project winning by name", async () => {
		// Drive loadConfig via HOME/CWD pointing at fixture dirs.
		const { writeFile, mkdir } = await import("node:fs/promises");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmp = await import("node:fs/promises").then((f) => f.mkdtemp(path.join(os.tmpdir(), "moa-cfg-")));

		const home = path.join(tmp, "home");
		const cwd = path.join(tmp, "proj");
		await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });

		await writeFile(
			path.join(home, ".pi", "agent", "moa.json"),
			JSON.stringify({
				default_preset: "default",
				presets: {
					default: validPreset,
					shared: { ...validPreset, max_tokens: 2048 },
				},
			}),
		);
		// Project overrides `shared` and sets a new default_preset.
		await writeFile(
			path.join(cwd, ".pi", "moa.json"),
			JSON.stringify({
				default_preset: "shared",
				presets: { shared: { ...validPreset, max_tokens: 9999 } },
			}),
		);

		const cfg = await loadConfig(home, cwd);
		expect(cfg.default_preset).toBe("shared"); // project wins
		expect(cfg.presets.shared.max_tokens).toBe(9999); // project wins
		expect(cfg.presets.default).toBeDefined(); // user preset retained

		const { rm } = await import("node:fs/promises");
		await rm(tmp, { recursive: true, force: true });
	});

	it("returns empty config when no files exist", async () => {
		const os = await import("node:os");
		const path = await import("node:path");
		const tmp = await import("node:fs/promises").then((f) => f.mkdtemp(path.join(os.tmpdir(), "moa-empty-")));
		const cfg = await loadConfig(tmp, tmp);
		expect(cfg.presets).toEqual({});
		const { rm } = await import("node:fs/promises");
		await rm(tmp, { recursive: true, force: true });
	});
});
