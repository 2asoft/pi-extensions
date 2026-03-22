import { basename, extname } from "node:path";
import type { ResolvedLspConfig, ResolvedLspServerConfig } from "../config/resolver.js";
import {
	createLspClientRuntime,
	type LspClientRuntime,
	type LspClientRuntimeOptions,
	type LspDiagnostic,
	type LspRuntimeStatus,
} from "./runtime.js";

export interface LspRuntimeRegistryServerStatus {
	name: string;
	fileTypes?: string[];
	status: LspRuntimeStatus;
}

export interface LspRuntimeRegistryStatus {
	state: "inactive" | "starting" | "ready" | "error";
	reason: string;
	configuredServers: number;
	activeServers: number;
	servers: LspRuntimeRegistryServerStatus[];
}

export interface LspRuntimeRegistryRequestOptions {
	path?: string;
	timeoutMs?: number;
}

export interface LspRuntimeRegistry {
	start(config: ResolvedLspConfig): Promise<void>;
	stop(): Promise<void>;
	reload(config: ResolvedLspConfig): Promise<void>;
	request(method: string, params: unknown, options?: LspRuntimeRegistryRequestOptions): Promise<unknown>;
	getPublishedDiagnostics(filePath?: string): LspDiagnostic[];
	getStatus(): LspRuntimeRegistryStatus;
	getStatusForPath(filePath: string): LspRuntimeStatus | undefined;
}

export interface LspRuntimeRegistryOptions extends Omit<LspClientRuntimeOptions, "spawn"> {
	createRuntime?: () => LspClientRuntime;
}

interface RuntimeEntry {
	server: ResolvedLspServerConfig;
	runtime: LspClientRuntime;
}

export function createLspRuntimeRegistry(options: LspRuntimeRegistryOptions = {}): LspRuntimeRegistry {
	const createRuntime = options.createRuntime ?? (() => createLspClientRuntime(options));
	const activeEntries = new Map<string, RuntimeEntry>();
	let discoveredServers: ResolvedLspServerConfig[] = [];
	let lifecycle: LspRuntimeRegistryStatus["state"] = "inactive";
	let lifecycleReason = "LSP registry has not started.";

	return {
		async start(config: ResolvedLspConfig): Promise<void> {
			await this.stop();

			discoveredServers = normalizeServers(config);
			if (discoveredServers.length === 0) {
				lifecycle = "inactive";
				lifecycleReason = "No LSP servers configured.";
				return;
			}

			lifecycle = "inactive";
			lifecycleReason = `Discovered ${discoveredServers.length} LSP server(s).`;
		},

		async stop(): Promise<void> {
			const stopPromises = [...activeEntries.values()].map(({ runtime }) => runtime.stop());
			await Promise.allSettled(stopPromises);
			activeEntries.clear();
			discoveredServers = [];
			lifecycle = "inactive";
			lifecycleReason = "LSP registry stopped.";
		},

		async reload(config: ResolvedLspConfig): Promise<void> {
			await this.start(config);
		},

		async request(method: string, params: unknown, options: LspRuntimeRegistryRequestOptions = {}): Promise<unknown> {
			const server = options.path ? selectServerForPath(options.path) : selectWorkspaceServer();
			if (!server) {
				throw new Error("No LSP server is configured.");
			}

			const entry = await ensureRuntimeStarted(server);
			const status = entry.runtime.getStatus();
			if (status.state !== "ready") {
				throw new Error(`LSP server ${entry.server.name} is not ready: ${status.reason}`);
			}
			return entry.runtime.request(method, params, options.timeoutMs);
		},

		getPublishedDiagnostics(filePath?: string): LspDiagnostic[] {
			if (filePath) {
				const server = selectServerForPath(filePath);
				if (!server) {
					return [];
				}
				const entry = activeEntries.get(server.name);
				return entry?.runtime.getPublishedDiagnostics(filePath) ?? [];
			}

			const diagnostics: LspDiagnostic[] = [];
			for (const { runtime } of activeEntries.values()) {
				diagnostics.push(...runtime.getPublishedDiagnostics());
			}
			return diagnostics;
		},

		getStatus(): LspRuntimeRegistryStatus {
			syncLifecycle();
			const servers = discoveredServers.map((server) => ({
				name: server.name,
				fileTypes: server.fileTypes,
				status: getServerStatus(server),
			}));
			const activeServers = servers.filter((server) => server.status.state === "ready").length;

			return {
				state: lifecycle,
				reason: lifecycleReason,
				configuredServers: discoveredServers.length,
				activeServers,
				servers,
			};
		},

		getStatusForPath(filePath: string): LspRuntimeStatus | undefined {
			const server = selectServerForPath(filePath);
			if (!server) {
				return undefined;
			}
			return getServerStatus(server);
		},
	};

	function selectServerForPath(filePath: string): ResolvedLspServerConfig | undefined {
		if (discoveredServers.length === 0) {
			return undefined;
		}

		const extension = extname(filePath).toLowerCase();
		const fileName = basename(filePath).toLowerCase();
		const exactMatches = discoveredServers.filter((server) => serverMatchesFile(server, extension, fileName));
		if (exactMatches.length > 0) {
			return exactMatches[0];
		}

		const fallbackMatches = discoveredServers.filter((server) => !server.fileTypes || server.fileTypes.length === 0);
		if (fallbackMatches.length > 0) {
			return fallbackMatches[0];
		}

		return discoveredServers[0];
	}

	function selectWorkspaceServer(): ResolvedLspServerConfig | undefined {
		const readyEntry = [...activeEntries.values()].find((entry) => entry.runtime.getStatus().state === "ready");
		if (readyEntry) {
			return readyEntry.server;
		}

		const activeEntry = activeEntries.values().next().value;
		if (activeEntry) {
			return activeEntry.server;
		}

		return discoveredServers[0];
	}

	async function ensureRuntimeStarted(server: ResolvedLspServerConfig): Promise<RuntimeEntry> {
		const existing = activeEntries.get(server.name);
		if (existing) {
			return existing;
		}

		const runtime = createRuntime();
		const entry = { server, runtime };
		activeEntries.set(server.name, entry);
		await runtime.start(server.command);
		return entry;
	}

	function getServerStatus(server: ResolvedLspServerConfig): LspRuntimeStatus {
		return activeEntries.get(server.name)?.runtime.getStatus() ?? createInactiveStatus(server.command);
	}

	function syncLifecycle(): void {
		if (discoveredServers.length === 0) {
			lifecycle = "inactive";
			lifecycleReason = "No LSP servers configured.";
			return;
		}

		const serverStatuses = [...activeEntries.values()].map((entry) => entry.runtime.getStatus());
		if (serverStatuses.length === 0) {
			lifecycle = "inactive";
			lifecycleReason = "No active LSP servers.";
			return;
		}

		const active = serverStatuses.filter((status) => status.state === "ready").length;
		if (active > 0) {
			lifecycle = "ready";
			lifecycleReason = `Connected to ${active} LSP server(s).`;
			return;
		}

		if (serverStatuses.some((status) => status.state === "starting")) {
			lifecycle = "starting";
			lifecycleReason = "LSP servers are starting.";
			return;
		}

		const firstError = serverStatuses.find((status) => status.state === "error");
		if (firstError) {
			lifecycle = "error";
			lifecycleReason = firstError.reason;
			return;
		}

		lifecycle = "inactive";
		lifecycleReason = "No active LSP servers.";
	}
}

function normalizeServers(config: ResolvedLspConfig): ResolvedLspServerConfig[] {
	if (config.servers.length > 0) {
		return config.servers;
	}
	if (!config.serverCommand) {
		return [];
	}
	return [
		{
			name: "default",
			command: config.serverCommand,
		},
	];
}

function createInactiveStatus(configuredCommand: string[] | undefined): LspRuntimeStatus {
	return {
		state: "inactive",
		reason: "LSP server has not been activated yet.",
		configuredCommand,
		activeCommand: undefined,
		transport: undefined,
		lspmuxAvailable: false,
		fallbackReason: undefined,
		pid: undefined,
		diagnosticsCount: 0,
	};
}

function serverMatchesFile(server: ResolvedLspServerConfig, extension: string, fileName: string): boolean {
	if (!server.fileTypes || server.fileTypes.length === 0) {
		return false;
	}
	const normalized = server.fileTypes.map((value) => value.toLowerCase());
	return normalized.includes(extension) || normalized.includes(fileName);
}
