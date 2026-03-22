import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspRuntimeRegistry, LspRuntimeRegistryStatus } from "../src/client/registry.js";
import type { LspRuntimeStatus } from "../src/client/runtime.js";
import { createWriteThroughHooks } from "../src/hooks/writethrough.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createInactiveStatus(): LspRuntimeStatus {
	return {
		state: "inactive",
		reason: "LSP server has not been activated yet.",
		configuredCommand: ["/usr/bin/ts"],
		activeCommand: undefined,
		transport: undefined,
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: undefined,
		diagnosticsCount: 0,
	};
}

function createRuntime(): {
	runtime: LspRuntimeRegistry;
	requests: Array<{ method: string; params: unknown; path?: string }>;
} {
	const requests: Array<{ method: string; params: unknown; path?: string }> = [];
	const status: LspRuntimeRegistryStatus = {
		state: "inactive",
		reason: "No active LSP servers.",
		configuredServers: 1,
		activeServers: 0,
		servers: [],
	};
	const runtime: LspRuntimeRegistry = {
		async start() {},
		async stop() {},
		async reload() {},
		async request(method: string, params: unknown, options?: { path?: string }) {
			requests.push({ method, params, path: options?.path });
			if (method === "textDocument/formatting") {
				return [];
			}
			if (method === "textDocument/diagnostic") {
				return { items: [] };
			}
			return null;
		},
		getPublishedDiagnostics() {
			return [];
		},
		getStatus() {
			return status;
		},
		getStatusForPath() {
			return createInactiveStatus();
		},
	};

	return { runtime, requests };
}

function createPiHarness(): {
	pi: ExtensionAPI;
	emitToolResult: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>;
} {
	let handler: ((event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		on(eventName: string, nextHandler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void>) {
			if (eventName === "tool_result") {
				handler = nextHandler;
			}
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		async emitToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
			if (!handler) {
				throw new Error("tool_result handler was not registered");
			}
			await handler(event, ctx);
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp write-through", () => {
	it("activates the matching runtime lazily during write-through formatting", async () => {
		const cwd = createTempDir("lsp-writethrough-");
		writeFileSync(join(cwd, "src.ts"), "const value=1\n", "utf8");
		const { runtime, requests } = createRuntime();
		const { pi, emitToolResult } = createPiHarness();
		const notify = vi.fn();
		const hooks = createWriteThroughHooks(runtime, { cwd });
		hooks.register(pi);

		await emitToolResult(
			{
				isError: false,
				toolName: "write",
				input: { path: "src.ts" },
			} as unknown as ToolResultEvent,
			{
				ui: {
					notify,
				},
			} as unknown as ExtensionContext,
		);

		expect(requests.map((request) => request.method)).toEqual(["textDocument/formatting", "textDocument/diagnostic"]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no formatting changes"), "info");
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("skipped"), "warning");
	});
});
