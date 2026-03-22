import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLspRuntimeRegistry } from "../src/client/registry.js";
import type { LspClientRuntime, LspLaunchConfig, LspRuntimeStatus } from "../src/client/runtime.js";
import type { ResolvedLspConfig } from "../src/config/resolver.js";

const tempDirs: string[] = [];

class DocumentSyncRuntime implements LspClientRuntime {
	readonly requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
	readonly notifications: Array<{ method: string; params: unknown }> = [];
	private readonly openDocuments = new Set<string>();
	private status: LspRuntimeStatus = {
		state: "inactive",
		reason: "not started",
		configuredCommand: undefined,
		activeCommand: undefined,
		transport: undefined,
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: undefined,
		diagnosticsCount: 0,
	};

	async start(configuredLaunch: LspLaunchConfig | undefined): Promise<void> {
		this.status = {
			...this.status,
			state: configuredLaunch?.command && configuredLaunch.command.length > 0 ? "ready" : "inactive",
			reason: configuredLaunch?.command && configuredLaunch.command.length > 0 ? "ready" : "not configured",
			configuredCommand: configuredLaunch?.command,
			activeCommand: configuredLaunch?.command,
			transport: "direct",
			pid: 100,
		};
	}

	async stop(): Promise<void> {
		this.openDocuments.clear();
		this.status = {
			...this.status,
			state: "inactive",
			reason: "stopped",
			activeCommand: undefined,
			pid: undefined,
		};
	}

	async reload(configuredLaunch: LspLaunchConfig | undefined): Promise<void> {
		await this.stop();
		await this.start(configuredLaunch);
	}

	seedOpenDocument(uri: string): void {
		this.openDocuments.add(uri);
	}

	notify(method: string, params: unknown): void {
		this.notifications.push({ method, params });
		if (method !== "textDocument/didOpen") {
			return;
		}

		const uri = getTextDocumentUri(params);
		if (!uri) {
			return;
		}

		this.openDocuments.add(uri);
	}

	async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		this.requests.push({ method, params, timeoutMs });
		const uri = getTextDocumentUri(params);
		if (method.startsWith("textDocument/") && uri && !this.openDocuments.has(uri)) {
			throw new Error(`file not found: ${uri}`);
		}
		return { method, uri };
	}

	getPublishedDiagnostics(): [] {
		return [];
	}

	getStatus(): LspRuntimeStatus {
		return { ...this.status };
	}
}

function getTextDocumentUri(params: unknown): string | undefined {
	if (!params || typeof params !== "object") {
		return undefined;
	}

	const record = params as { textDocument?: unknown };
	if (!record.textDocument || typeof record.textDocument !== "object") {
		return undefined;
	}

	const textDocument = record.textDocument as { uri?: unknown };
	return typeof textDocument.uri === "string" ? textDocument.uri : undefined;
}

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function basicConfig(): ResolvedLspConfig {
	return {
		serverCommand: undefined,
		servers: [
			{
				name: "ts",
				command: ["/usr/bin/ts"],
				fileTypes: [".ts", ".tsx"],
			},
		],
	};
}

function createWorkspace(): { cwd: string; path: string; uri: string } {
	const cwd = createTempDir("lsp-document-sync-");
	const srcDir = join(cwd, "src");
	mkdirSync(srcDir, { recursive: true });
	const path = join(srcDir, "main.ts");
	writeFileSync(path, "export const value = 1;\n", "utf8");
	return {
		cwd,
		path,
		uri: pathToFileURL(path).href,
	};
}

function createRegistry(cwd: string, runtime = new DocumentSyncRuntime()) {
	const registry = createLspRuntimeRegistry({
		cwd,
		createRuntime: () => runtime,
	});
	return { registry, runtime };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp document synchronization", () => {
	it("opens a document before the first hover request on a cold runtime", async () => {
		const workspace = createWorkspace();
		const { registry } = createRegistry(workspace.cwd);

		await registry.start(basicConfig());

		await expect(
			registry.request(
				"textDocument/hover",
				{
					textDocument: { uri: workspace.uri },
					position: { line: 0, character: 13 },
				},
				{ path: "src/main.ts" },
			),
		).resolves.toEqual({ method: "textDocument/hover", uri: workspace.uri });

		await registry.stop();
	});

	it("opens a document before the first diagnostics request on a cold runtime", async () => {
		const workspace = createWorkspace();
		const { registry } = createRegistry(workspace.cwd);

		await registry.start(basicConfig());

		await expect(
			registry.request(
				"textDocument/diagnostic",
				{
					textDocument: { uri: workspace.uri },
				},
				{ path: "src/main.ts" },
			),
		).resolves.toEqual({ method: "textDocument/diagnostic", uri: workspace.uri });

		await registry.stop();
	});

	it("sends didChange before the next request when on-disk contents change", async () => {
		const workspace = createWorkspace();
		const { registry, runtime } = createRegistry(workspace.cwd);
		runtime.seedOpenDocument(workspace.uri);

		await registry.start(basicConfig());
		await expect(
			registry.request(
				"textDocument/hover",
				{
					textDocument: { uri: workspace.uri },
					position: { line: 0, character: 13 },
				},
				{ path: "src/main.ts" },
			),
		).resolves.toEqual({ method: "textDocument/hover", uri: workspace.uri });

		writeFileSync(workspace.path, "export const value = 2;\n", "utf8");

		await expect(
			registry.request(
				"textDocument/hover",
				{
					textDocument: { uri: workspace.uri },
					position: { line: 0, character: 13 },
				},
				{ path: "src/main.ts" },
			),
		).resolves.toEqual({ method: "textDocument/hover", uri: workspace.uri });

		expect(runtime.notifications.map((notification) => notification.method)).toContain("textDocument/didChange");

		await registry.stop();
	});
});
