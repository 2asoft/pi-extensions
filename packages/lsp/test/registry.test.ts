import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspRuntimeRegistry } from "../src/client/registry.js";
import type { LspClientRuntime, LspLaunchConfig, LspRuntimeStatus } from "../src/client/runtime.js";
import type { ResolvedLspConfig } from "../src/config/resolver.js";

const tempDirs: string[] = [];

class FakeRuntime implements LspClientRuntime {
	requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
	status: LspRuntimeStatus = {
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

	async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		this.requests.push({ method, params, timeoutMs });
		return { method };
	}

	getPublishedDiagnostics(): [] {
		return [];
	}

	getStatus(): LspRuntimeStatus {
		return { ...this.status };
	}
}

class ControlledStartRuntime extends FakeRuntime {
	private readonly started = Promise.withResolvers<void>();

	override async start(configuredLaunch: LspLaunchConfig | undefined): Promise<void> {
		this.status = {
			...this.status,
			state: "starting",
			reason: "starting",
			configuredCommand: configuredLaunch?.command,
			activeCommand: configuredLaunch?.command,
			transport: "direct",
			pid: 100,
		};
		await this.started.promise;
		await super.start(configuredLaunch);
	}

	releaseStart(): void {
		this.started.resolve();
	}
}

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function basicConfig(): ResolvedLspConfig {
	return {
		serverCommand: ["/usr/bin/default"],
		servers: [
			{
				name: "ts",
				command: ["/usr/bin/ts"],
				fileTypes: [".ts", ".tsx"],
			},
			{
				name: "py",
				command: ["/usr/bin/py"],
				fileTypes: [".py"],
			},
			{
				name: "fallback",
				command: ["/usr/bin/fallback"],
			},
		],
	};
}

function multiRootConfig(): ResolvedLspConfig {
	return {
		serverCommand: undefined,
		servers: [
			{
				name: "ts",
				command: ["/usr/bin/ts"],
				fileTypes: [".ts", ".tsx"],
				rootStrategy: {
					type: "nearest",
					markers: ["package.json"],
				},
			},
		],
	};
}

function createRegistry(options: { cwd?: string; runtimes?: LspClientRuntime[] } = {}) {
	const runtimes = options.runtimes ?? [new FakeRuntime(), new FakeRuntime(), new FakeRuntime()];
	let allocations = 0;
	const registry = createLspRuntimeRegistry({
		cwd: options.cwd,
		createRuntime: () => {
			allocations += 1;
			const runtime = runtimes.shift();
			if (!runtime) {
				throw new Error("Unexpected runtime allocation");
			}
			return runtime;
		},
	});

	return {
		registry,
		getAllocations: () => allocations,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp runtime registry", () => {
	it("does not spawn any runtimes during registry start", async () => {
		const { registry, getAllocations } = createRegistry();

		await registry.start(basicConfig());

		expect(getAllocations()).toBe(0);
		const status = registry.getStatus();
		expect(status.configuredServers).toBe(3);
		expect(status.activeServers).toBe(0);
		expect(status.servers.map((server) => server.name)).toEqual(["ts", "py", "fallback"]);

		await registry.stop();
	});

	it("routes file-scoped requests by file type with fallback and activates lazily", async () => {
		const { registry, getAllocations } = createRegistry();

		await registry.start(basicConfig());
		await registry.request("textDocument/hover", { token: "ts" }, { path: "src/main.ts" });
		await registry.request("textDocument/hover", { token: "py" }, { path: "src/main.py" });
		await registry.request("textDocument/hover", { token: "md" }, { path: "README.md" });

		expect(getAllocations()).toBe(3);
		expect(registry.getStatusForPath("src/main.ts")?.activeCommand).toEqual(["/usr/bin/ts"]);
		expect(registry.getStatusForPath("src/main.py")?.activeCommand).toEqual(["/usr/bin/py"]);
		expect(registry.getStatusForPath("README.md")?.activeCommand).toEqual(["/usr/bin/fallback"]);

		const status = registry.getStatus();
		expect(status.state).toBe("ready");
		expect(status.configuredServers).toBe(3);
		expect(status.activeServers).toBe(3);

		await registry.stop();
	});

	it("reuses an existing runtime for later requests in the same root", async () => {
		const { registry, getAllocations } = createRegistry();

		await registry.start(basicConfig());
		await registry.request("textDocument/hover", { token: "first" }, { path: "src/main.ts" });
		await registry.request("textDocument/hover", { token: "second" }, { path: "src/util.tsx" });

		expect(getAllocations()).toBe(1);
		expect(registry.getStatusForPath("src/main.ts")?.activeCommand).toEqual(["/usr/bin/ts"]);

		await registry.stop();
	});

	it("uses the first active server for workspace-scoped requests", async () => {
		const { registry, getAllocations } = createRegistry();

		await registry.start(basicConfig());
		await registry.request("textDocument/hover", { token: "ts" }, { path: "src/main.ts" });
		await registry.request("workspace/symbol", { query: "x" });

		expect(getAllocations()).toBe(1);
		expect(registry.getStatus().activeServers).toBe(1);

		await registry.stop();
	});

	it("deduplicates concurrent startup for the same provider and root", async () => {
		const workspaceRoot = createTempDir("lsp-registry-");
		const packageRoot = join(workspaceRoot, "packages", "app");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "app" }), "utf8");
		const runtime = new ControlledStartRuntime();
		const { registry, getAllocations } = createRegistry({
			cwd: workspaceRoot,
			runtimes: [runtime, new FakeRuntime()],
		});

		await registry.start(multiRootConfig());
		const firstRequest = registry.request(
			"textDocument/hover",
			{ token: "first" },
			{ path: "packages/app/src/main.ts" },
		);
		const secondRequest = registry.request(
			"textDocument/hover",
			{ token: "second" },
			{ path: "packages/app/src/util.ts" },
		);

		await Promise.resolve();
		expect(getAllocations()).toBe(1);

		runtime.releaseStart();
		await Promise.all([firstRequest, secondRequest]);

		expect(getAllocations()).toBe(1);
		expect(runtime.requests).toHaveLength(2);

		await registry.stop();
	});

	it("creates separate runtimes for the same provider in different roots", async () => {
		const workspaceRoot = createTempDir("lsp-registry-");
		const appARoot = join(workspaceRoot, "apps", "a");
		const appBRoot = join(workspaceRoot, "apps", "b");
		mkdirSync(appARoot, { recursive: true });
		mkdirSync(appBRoot, { recursive: true });
		writeFileSync(join(appARoot, "package.json"), JSON.stringify({ name: "app-a" }), "utf8");
		writeFileSync(join(appBRoot, "package.json"), JSON.stringify({ name: "app-b" }), "utf8");
		const { registry, getAllocations } = createRegistry({
			cwd: workspaceRoot,
			runtimes: [new FakeRuntime(), new FakeRuntime()],
		});

		await registry.start(multiRootConfig());
		await registry.request("textDocument/hover", { token: "a" }, { path: "apps/a/src/main.ts" });
		await registry.request("textDocument/hover", { token: "b" }, { path: "apps/b/src/main.ts" });

		expect(getAllocations()).toBe(2);
		expect(registry.getStatus().activeServers).toBe(2);

		await registry.stop();
	});
});
