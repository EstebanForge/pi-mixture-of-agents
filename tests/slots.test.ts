/**
 * Unit tests for lib/slots.ts without touching the network or pi-ai.
 *
 * `@earendil-works/pi-ai/compat` is mocked so getModel/complete are stubs we
 * drive from each test. Covers the four production failure modes that had no
 * offline coverage: recursion guard, catalog miss, auth failure, empty
 * response — plus the aggregator recursion guard.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub state. Reset before each test so calls don't bleed across cases.
const mockModel = { id: "m", provider: "p" };
const state = {
	getModel: vi.fn(),
	complete: vi.fn(),
};

vi.mock("@earendil-works/pi-ai/compat", () => ({
	getModel: (...args: unknown[]) => state.getModel(...args),
	complete: (...args: unknown[]) => state.complete(...args),
}));

// Import AFTER vi.mock is registered (vitest hoists vi.mock above imports).
const { makeCallSlot, callAggregator } = await import("../lib/slots");
import type { SlotContext } from "../lib/types";

function fakeCtx(authOk: boolean): SlotContext {
	return {
		modelRegistry: {
			getApiKeyAndHeaders: async (_model: unknown) =>
				authOk
					? { ok: true as const, apiKey: "k", headers: undefined, env: undefined }
					: { ok: false as const, error: "no creds" },
		},
	};
}

const slot = { provider: "p", model: "m" };

beforeEach(() => {
	state.getModel.mockReset();
	state.complete.mockReset();
});

describe("makeCallSlot", () => {
	it("rejects a recursive moa: slot without touching the registry", async () => {
		const call = makeCallSlot(fakeCtx(true));
		await expect(call({ provider: "moa", model: "x" }, "hi", {})).rejects.toThrow(/recursively reference MoA/);
		expect(state.getModel).not.toHaveBeenCalled();
	});

	it("throws when the model is not in the catalog", async () => {
		state.getModel.mockReturnValue(undefined);
		const call = makeCallSlot(fakeCtx(true));
		await expect(call(slot, "hi", {})).rejects.toThrow(/not in catalog/);
	});

	it("throws on auth failure", async () => {
		state.getModel.mockReturnValue(mockModel);
		const call = makeCallSlot(fakeCtx(false));
		await expect(call(slot, "hi", {})).rejects.toThrow("no creds");
		expect(state.complete).not.toHaveBeenCalled();
	});

	it("throws on an empty response", async () => {
		state.getModel.mockReturnValue(mockModel);
		state.complete.mockResolvedValue({ content: [] });
		const call = makeCallSlot(fakeCtx(true));
		await expect(call(slot, "hi", {})).rejects.toThrow(/empty response/);
	});

	it("returns joined text on a successful call", async () => {
		state.getModel.mockReturnValue(mockModel);
		state.complete.mockResolvedValue({
			content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
		});
		const call = makeCallSlot(fakeCtx(true));
		await expect(call(slot, "hi", {})).resolves.toBe("hello\nworld");
	});
});

describe("callAggregator", () => {
	it("rejects a recursive moa: aggregator", async () => {
		await expect(
			callAggregator({ provider: "moa", model: "x" }, fakeCtx(true), { messages: [] }),
		).rejects.toThrow(/aggregator cannot be a MoA preset/);
		expect(state.getModel).not.toHaveBeenCalled();
	});

	it("throws when the aggregator model is not in the catalog", async () => {
		state.getModel.mockReturnValue(undefined);
		await expect(callAggregator(slot, fakeCtx(true), { messages: [] })).rejects.toThrow(/not in catalog/);
	});
});
