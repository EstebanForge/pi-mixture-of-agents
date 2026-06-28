import { describe, expect, it } from "vitest";
import { terminalEventFor } from "../lib/stream-facade";

describe("terminalEventFor (C2 regression: done vs error branching)", () => {
	it("routes stopReason 'stop' to a done event", () => {
		expect(terminalEventFor("stop")).toEqual({ kind: "done", reason: "stop" });
	});

	it("routes 'length' and 'toolUse' to done", () => {
		expect(terminalEventFor("length")).toEqual({ kind: "done", reason: "length" });
		expect(terminalEventFor("toolUse")).toEqual({ kind: "done", reason: "toolUse" });
	});

	it("routes 'error' to an error event (not done)", () => {
		expect(terminalEventFor("error")).toEqual({ kind: "error", reason: "error" });
	});

	it("routes 'aborted' to an error event (not done)", () => {
		expect(terminalEventFor("aborted")).toEqual({ kind: "error", reason: "aborted" });
	});

	it("defaults undefined to done/stop", () => {
		expect(terminalEventFor(undefined)).toEqual({ kind: "done", reason: "stop" });
	});
});
