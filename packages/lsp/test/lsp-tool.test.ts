import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { LspRuntimeRegistry, LspRuntimeRegistryStatus } from "../src/client/registry.js";
import type { LspRuntimeStatus } from "../src/client/runtime.js";
import { createLspToolRouter } from "../src/tools/lsp-tool.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createReadyStatus(): LspRuntimeStatus {
	return {
		state: "ready",
		reason: "ready",
		configuredCommand: ["/usr/bin/rust-analyzer"],
		activeCommand: ["/usr/bin/rust-analyzer"],
		transport: "direct",
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: 100,
		diagnosticsCount: 0,
	};
}

function createRuntime(payload: unknown): {
	runtime: LspRuntimeRegistry;
	requests: Array<{ method: string; params: unknown; path?: string; timeoutMs?: number }>;
} {
	const requests: Array<{ method: string; params: unknown; path?: string; timeoutMs?: number }> = [];
	const status: LspRuntimeRegistryStatus = {
		state: "ready",
		reason: "Connected to 1 LSP server(s).",
		configuredServers: 1,
		activeServers: 1,
		servers: [],
	};
	const runtime: LspRuntimeRegistry = {
		async start() {},
		async stop() {},
		async reload() {},
		async request(method: string, params: unknown, options?: { path?: string; timeoutMs?: number }) {
			requests.push({ method, params, path: options?.path, timeoutMs: options?.timeoutMs });
			return payload;
		},
		getPublishedDiagnostics() {
			return [];
		},
		getStatus() {
			return status;
		},
		getStatusForPath() {
			return createReadyStatus();
		},
	};

	return { runtime, requests };
}

function createPiHarness(): {
	pi: ExtensionAPI;
	executeTool(name: string, params: Record<string, unknown>): Promise<unknown>;
} {
	const tools = new Map<
		string,
		{ execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }
	>();
	const pi = {
		registerTool(definition: {
			name: string;
			execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
		}) {
			tools.set(definition.name, definition);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		async executeTool(name: string, params: Record<string, unknown>): Promise<unknown> {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`Tool ${name} was not registered`);
			}
			return tool.execute("tool-call", params);
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp tool router", () => {
	it("uses an extended timeout for workspace symbol queries", async () => {
		const { runtime, requests } = createRuntime([{ name: "VoxelWorldPlugin" }]);
		const { pi, executeTool } = createPiHarness();
		const router = createLspToolRouter(runtime, {
			cwd: "/workspace",
			getResolvedConfig: () => ({ serverCommand: undefined, servers: [] }),
		});
		router.register(pi);

		await executeTool("lsp", {
			action: "symbols",
			query: "VoxelWorldPlugin",
		});

		expect(requests).toEqual([
			{
				method: "workspace/symbol",
				params: { query: "VoxelWorldPlugin" },
				path: undefined,
				timeoutMs: 10_000,
			},
		]);
	});

	it("returns rename workspace edits as a preview and leaves files unchanged", async () => {
		const cwd = createTempDir("lsp-tool-");
		const filePath = join(cwd, "main.ts");
		const originalText = "const oldName = 1;\n";
		writeFileSync(filePath, originalText, "utf8");
		const workspaceEdit = {
			documentChanges: [
				{
					textDocument: {
						uri: "file:///workspace/main.ts",
						version: 1,
					},
					edits: [
						{
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 13 },
							},
							newText: "newName",
						},
					],
				},
			],
		};
		const { runtime, requests } = createRuntime(workspaceEdit);
		const { pi, executeTool } = createPiHarness();
		const router = createLspToolRouter(runtime, {
			cwd,
			getResolvedConfig: () => ({ serverCommand: undefined, servers: [] }),
		});
		router.register(pi);

		const result = (await executeTool("lsp", {
			action: "rename",
			path: "main.ts",
			line: 0,
			character: 6,
			newName: "newName",
		})) as {
			content: Array<{ type: string; text: string }>;
			details: { action: string; payload: unknown };
		};

		expect(requests).toEqual([
			{
				method: "textDocument/rename",
				params: {
					textDocument: { uri: expect.stringMatching(/^file:\/\//) },
					position: { line: 0, character: 6 },
					newName: "newName",
				},
				path: "main.ts",
			},
		]);
		expect(result.details).toEqual({
			action: "rename",
			payload: workspaceEdit,
		});
		expect(result.content[0]?.text).toContain("preview only");
		expect(result.content[0]?.text).toContain("workspace edit");
		expect(readFileSync(filePath, "utf8")).toBe(originalText);
	});
});
