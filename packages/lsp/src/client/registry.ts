import { readFile } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedLspConfig, ResolvedLspServerConfig } from "../config/resolver.js";
import { type LspRootStrategy, resolveRoot } from "../config/root-detection.js";
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
	rootPath?: string;
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
	rootPath: string;
	runtime: LspClientRuntime;
}

interface ServerSelection {
	server: ResolvedLspServerConfig;
	rootPath: string;
}

interface DocumentState {
	languageId: string;
	text: string;
	version: number;
}

const fallbackRootStrategy: LspRootStrategy = { type: "fallback-cwd" };
const documentScopedMethods = new Set([
	"textDocument/hover",
	"textDocument/definition",
	"textDocument/references",
	"textDocument/rename",
	"textDocument/diagnostic",
	"textDocument/documentSymbol",
	"textDocument/formatting",
]);

export function createLspRuntimeRegistry(options: LspRuntimeRegistryOptions = {}): LspRuntimeRegistry {
	const createRuntime = options.createRuntime ?? (() => createLspClientRuntime(options));
	const cwd = options.cwd ?? process.cwd();
	const activeEntries = new Map<string, RuntimeEntry>();
	const startingEntries = new Map<string, Promise<RuntimeEntry>>();
	const documentStates = new Map<string, DocumentState>();
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
			startingEntries.clear();
			documentStates.clear();
			discoveredServers = [];
			lifecycle = "inactive";
			lifecycleReason = "LSP registry stopped.";
		},

		async reload(config: ResolvedLspConfig): Promise<void> {
			await this.start(config);
		},

		async request(method: string, params: unknown, options: LspRuntimeRegistryRequestOptions = {}): Promise<unknown> {
			const selection = options.path ? selectServerForPath(options.path) : selectWorkspaceServer();
			if (!selection) {
				throw new Error("No LSP server is configured.");
			}

			const entry = await ensureRuntimeStarted(selection);
			const status = entry.runtime.getStatus();
			if (status.state !== "ready") {
				throw new Error(`LSP server ${entry.server.name} is not ready: ${status.reason}`);
			}
			if (options.path && documentScopedMethods.has(method) && hasTextDocumentParams(params)) {
				await synchronizeDocument(entry, options.path);
			}
			return entry.runtime.request(method, params, options.timeoutMs);
		},

		getPublishedDiagnostics(filePath?: string): LspDiagnostic[] {
			if (filePath) {
				const selection = selectServerForPath(filePath);
				if (!selection) {
					return [];
				}
				const entry = activeEntries.get(runtimeKey(selection.server, selection.rootPath));
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
			const activeServerStatuses = [...activeEntries.values()].map((entry) => ({
				name: entry.server.name,
				fileTypes: entry.server.fileTypes,
				rootPath: entry.rootPath,
				status: entry.runtime.getStatus(),
			}));
			const inactiveDiscoveredServers = discoveredServers
				.filter((server) => !hasAnyActiveEntry(server))
				.map((server) => ({
					name: server.name,
					fileTypes: server.fileTypes,
					status: createInactiveStatus(server.command),
				}));
			const servers = [...activeServerStatuses, ...inactiveDiscoveredServers];

			return {
				state: lifecycle,
				reason: lifecycleReason,
				configuredServers: discoveredServers.length,
				activeServers: activeEntries.size,
				servers,
			};
		},

		getStatusForPath(filePath: string): LspRuntimeStatus | undefined {
			const selection = selectServerForPath(filePath);
			if (!selection) {
				return undefined;
			}
			return getServerStatus(selection);
		},
	};

	function resolveServerRoot(server: ResolvedLspServerConfig, pathLike: string): string | undefined {
		const strategy = server.rootStrategy ?? fallbackRootStrategy;
		const absolutePath = resolvePath(cwd, pathLike);
		return resolveRoot(strategy, absolutePath, cwd);
	}

	function selectServerForPath(filePath: string): ServerSelection | undefined {
		if (discoveredServers.length === 0) {
			return undefined;
		}

		const extension = extname(filePath).toLowerCase();
		const fileName = basename(filePath).toLowerCase();
		const exactMatches = discoveredServers.filter((server) => serverMatchesFile(server, extension, fileName));
		const exactSelection = selectRootedServer(exactMatches, filePath);
		if (exactSelection) {
			return exactSelection;
		}

		const fallbackMatches = discoveredServers.filter((server) => !server.fileTypes || server.fileTypes.length === 0);
		const fallbackSelection = selectRootedServer(fallbackMatches, filePath);
		if (fallbackSelection) {
			return fallbackSelection;
		}

		return selectRootedServer(discoveredServers, filePath);
	}

	function selectWorkspaceServer(): ServerSelection | undefined {
		const readyEntry = [...activeEntries.values()].find((entry) => entry.runtime.getStatus().state === "ready");
		if (readyEntry) {
			return {
				server: readyEntry.server,
				rootPath: readyEntry.rootPath,
			};
		}

		const activeEntry = activeEntries.values().next().value;
		if (activeEntry) {
			return {
				server: activeEntry.server,
				rootPath: activeEntry.rootPath,
			};
		}

		for (const server of sortServersByPriority(discoveredServers)) {
			const rootPath = resolveServerRoot(server, cwd);
			if (rootPath) {
				return { server, rootPath };
			}
		}

		return undefined;
	}

	function selectRootedServer(candidates: ResolvedLspServerConfig[], filePath: string): ServerSelection | undefined {
		for (const server of sortServersByPriority(candidates)) {
			const rootPath = resolveServerRoot(server, filePath);
			if (rootPath) {
				return { server, rootPath };
			}
		}
		return undefined;
	}

	async function ensureRuntimeStarted(selection: ServerSelection): Promise<RuntimeEntry> {
		const key = runtimeKey(selection.server, selection.rootPath);
		const starting = startingEntries.get(key);
		if (starting) {
			return starting;
		}

		const existing = activeEntries.get(key);
		if (existing) {
			return existing;
		}

		const startup = startRuntime(selection);
		startingEntries.set(key, startup);
		try {
			return await startup;
		} finally {
			startingEntries.delete(key);
		}
	}

	async function startRuntime(selection: ServerSelection): Promise<RuntimeEntry> {
		const runtime = createRuntime();
		const entry = {
			server: selection.server,
			rootPath: selection.rootPath,
			runtime,
		};
		activeEntries.set(runtimeKey(selection.server, selection.rootPath), entry);
		await runtime.start({
			command: selection.server.command,
			initializationOptions: selection.server.initializationOptions,
			environment: selection.server.environment,
		});
		return entry;
	}

	async function synchronizeDocument(entry: RuntimeEntry, filePath: string): Promise<void> {
		const absolutePath = resolvePath(cwd, filePath);
		const uri = pathToFileURL(absolutePath).href;
		const nextText = await readFile(absolutePath, "utf8");
		const key = documentKey(entry, uri);
		const existing = documentStates.get(key);
		if (!existing) {
			const languageId = resolveLanguageId(filePath, entry.server);
			entry.runtime.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: nextText,
				},
			});
			documentStates.set(key, { languageId, text: nextText, version: 1 });
			return;
		}
		if (existing.text === nextText) {
			return;
		}

		const nextVersion = existing.version + 1;
		entry.runtime.notify("textDocument/didChange", {
			textDocument: {
				uri,
				version: nextVersion,
			},
			contentChanges: [{ text: nextText }],
		});
		documentStates.set(key, {
			languageId: existing.languageId,
			text: nextText,
			version: nextVersion,
		});
	}

	function getServerStatus(selection: ServerSelection): LspRuntimeStatus {
		return (
			activeEntries.get(runtimeKey(selection.server, selection.rootPath))?.runtime.getStatus() ??
			createInactiveStatus(selection.server.command)
		);
	}

	function hasAnyActiveEntry(server: ResolvedLspServerConfig): boolean {
		for (const entry of activeEntries.values()) {
			if (entry.server.name === server.name) {
				return true;
			}
		}
		return false;
	}

	function sortServersByPriority(candidates: ResolvedLspServerConfig[]): ResolvedLspServerConfig[] {
		return [...candidates].sort((left, right) => priorityWeight(left.priority) - priorityWeight(right.priority));
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

function runtimeKey(server: ResolvedLspServerConfig, rootPath: string): string {
	return `${server.name}:${rootPath}`;
}

function documentKey(entry: RuntimeEntry, uri: string): string {
	return `${runtimeKey(entry.server, entry.rootPath)}:${uri}`;
}

function resolveLanguageId(filePath: string, server: ResolvedLspServerConfig): string {
	const extension = extname(filePath).toLowerCase();
	const fileName = basename(filePath).toLowerCase();
	const languageIdByExtension: Record<string, string> = {
		".c": "c",
		".cc": "cpp",
		".cpp": "cpp",
		".cjs": "javascript",
		".cts": "typescript",
		".cxx": "cpp",
		".go": "go",
		".h": "c",
		".hh": "cpp",
		".hpp": "cpp",
		".hxx": "cpp",
		".java": "java",
		".js": "javascript",
		".json": "json",
		".jsonc": "jsonc",
		".jsx": "javascriptreact",
		".kt": "kotlin",
		".kts": "kotlin",
		".lua": "lua",
		".mjs": "javascript",
		".mts": "typescript",
		".py": "python",
		".rs": "rust",
		".ts": "typescript",
		".tsx": "typescriptreact",
		".yaml": "yaml",
		".yml": "yaml",
	};
	const languageIdByFileName: Record<string, string> = {
		dockerfile: "dockerfile",
	};

	return languageIdByExtension[extension] ?? languageIdByFileName[fileName] ?? server.name;
}

function priorityWeight(priority: ResolvedLspServerConfig["priority"]): number {
	switch (priority) {
		case "primary":
			return 0;
		case "secondary":
			return 1;
		case "linter":
			return 2;
		default:
			return 1;
	}
}

function serverMatchesFile(server: ResolvedLspServerConfig, extension: string, fileName: string): boolean {
	if (!server.fileTypes || server.fileTypes.length === 0) {
		return false;
	}
	const normalized = server.fileTypes.map((value) => value.toLowerCase());
	return normalized.includes(extension) || normalized.includes(fileName);
}

function hasTextDocumentParams(params: unknown): boolean {
	if (!params || typeof params !== "object") {
		return false;
	}
	const record = params as { textDocument?: unknown };
	return !!record.textDocument && typeof record.textDocument === "object";
}
