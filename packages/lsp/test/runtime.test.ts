import { describe, expect, it, vi } from "vitest";
import {
	createLspClientRuntime,
	type LspLaunchConfig,
	type LspSpawn,
	type LspSpawnOptions,
} from "../src/client/runtime.js";

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
};

type MockSpawnControls = {
	emit(payload: JsonRpcMessage): void;
	emitStderr(text: string): void;
	exit(code: number | null): void;
};

type CreateMockSpawnOptions = {
	onSpawn?: (options: LspSpawnOptions, controls: MockSpawnControls) => void;
	onRequest?: (message: JsonRpcMessage, controls: MockSpawnControls) => void;
	onKill?: () => void;
	ignoreStdinEnd?: boolean;
	asyncKillDelayMs?: number;
};

describe("lsp runtime", () => {
	it("uses string JSON-RPC request ids to avoid collisions with server requests", async () => {
		const requestIds: Array<number | string | undefined> = [];
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.id !== undefined) {
					requestIds.push(message.id);
				}
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: [{ name: "exampleSymbol" }],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({
			spawn,
			requestTimeoutMs: 200,
		});

		await runtime.start({ command: ["dummy-lsp"] });
		await runtime.request("workspace/symbol", { query: "example" }, 200);
		await runtime.stop();

		expect(requestIds).toEqual(["client-1", "client-2", "client-3"]);
	});

	it("handles numeric-string JSON-RPC response ids", async () => {
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							capabilities: {},
						},
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					controls.emit({
						jsonrpc: "2.0",
						id: String(message.id),
						result: [{ name: "exampleSymbol" }],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({
			spawn,
			requestTimeoutMs: 200,
		});

		await runtime.start({ command: ["dummy-lsp"] });
		const result = await runtime.request("workspace/symbol", { query: "example" }, 200);
		expect(result).toEqual([{ name: "exampleSymbol" }]);
		expect(runtime.getStatus().state).toBe("ready");

		await runtime.stop();
	});

	it("reports error when initialize handshake times out", async () => {
		const spawn = createMockSpawn({
			onRequest() {
				return;
			},
		});

		const runtime = createLspClientRuntime({
			spawn,
			requestTimeoutMs: 100,
		});

		await runtime.start({ command: ["dummy-lsp"] });
		const status = runtime.getStatus();
		expect(status.state).toBe("error");
		expect(status.reason).toContain("Timed out waiting for JSON-RPC response to initialize");

		expect(() => runtime.request("workspace/symbol", { query: "x" })).toThrow(/not ready/i);
		await runtime.stop();
	});

	it("passes initialization options in the initialize request", async () => {
		let initializeParams: unknown;
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					initializeParams = message.params;
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		const launchConfig: LspLaunchConfig = {
			command: ["dummy-lsp"],
			initializationOptions: {
				typescript: {
					preferences: {
						includeCompletionsForModuleExports: true,
					},
				},
			},
		};

		await runtime.start(launchConfig);
		expect(initializeParams).toMatchObject({
			initializationOptions: launchConfig.initializationOptions,
		});

		await runtime.stop();
	});

	it("passes environment overrides to the spawned process", async () => {
		let spawnEnv: NodeJS.ProcessEnv | undefined;
		const spawn = createMockSpawn({
			onSpawn(options) {
				spawnEnv = options.env;
			},
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({
			spawn,
			env: {
				BASE_ENV: "base",
			},
			requestTimeoutMs: 200,
		});

		await runtime.start({
			command: ["dummy-lsp"],
			environment: {
				BASE_ENV: "override",
				EXTRA_FLAG: "enabled",
			},
		});

		expect(spawnEnv).toMatchObject({
			BASE_ENV: "override",
			EXTRA_FLAG: "enabled",
		});

		await runtime.stop();
	});

	it("advertises initialize capabilities that keep workspace symbol results available", async () => {
		let supportsWorkspaceSymbols = false;
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					const params = message.params as {
						capabilities?: {
							window?: {
								workDoneProgress?: boolean;
							};
						};
					};
					supportsWorkspaceSymbols = params.capabilities?.window?.workDoneProgress === true;
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: supportsWorkspaceSymbols
							? [{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }]
							: [],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		await runtime.start({ command: ["dummy-lsp"] });

		const result = await runtime.request("workspace/symbol", { query: "VoxelWorldPlugin" }, 200);
		expect(result).toEqual([{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }]);

		await runtime.stop();
	});

	it("ignores server requests that reuse the same id as a pending client request", async () => {
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						method: "window/workDoneProgress/create",
						params: { token: "rustAnalyzer/Indexing" },
					});
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: [{ name: "VoxelWorldPlugin" }],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		await runtime.start({ command: ["dummy-lsp"] });

		const result = await runtime.request("workspace/symbol", { query: "VoxelWorldPlugin" }, 200);
		expect(result).toEqual([{ name: "VoxelWorldPlugin" }]);

		await runtime.stop();
	});

	it("retries the first workspace symbol request after startup progress completes", async () => {
		let workspaceSymbolRequests = 0;
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					workspaceSymbolRequests += 1;
					if (workspaceSymbolRequests === 1) {
						controls.emit({
							jsonrpc: "2.0",
							id: 0,
							method: "window/workDoneProgress/create",
							params: { token: "rustAnalyzer/Indexing" },
						});
						controls.emit({
							jsonrpc: "2.0",
							method: "$/progress",
							params: {
								token: "rustAnalyzer/Indexing",
								value: { kind: "begin", title: "Indexing" },
							},
						});
						controls.emit({
							jsonrpc: "2.0",
							id: message.id,
							result: [],
						});
						setTimeout(() => {
							controls.emit({
								jsonrpc: "2.0",
								method: "$/progress",
								params: {
									token: "rustAnalyzer/Indexing",
									value: { kind: "end" },
								},
							});
						}, 10);
						return;
					}

					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: [{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		await runtime.start({ command: ["dummy-lsp"] });

		const result = await runtime.request("workspace/symbol", { query: "VoxelWorldPlugin" }, 200);
		expect(result).toEqual([{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }]);
		expect(workspaceSymbolRequests).toBe(2);

		await runtime.stop();
	});

	it("keeps retrying workspace symbol while startup progress still produces placeholder results", async () => {
		let workspaceSymbolRequests = 0;
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "workspace/symbol") {
					workspaceSymbolRequests += 1;
					if (workspaceSymbolRequests === 1) {
						controls.emit({
							jsonrpc: "2.0",
							method: "$/progress",
							params: {
								token: "rustAnalyzer/Fetching",
								value: { kind: "begin", title: "Fetching" },
							},
						});
						controls.emit({ jsonrpc: "2.0", id: message.id, result: [] });
						setTimeout(() => {
							controls.emit({
								jsonrpc: "2.0",
								method: "$/progress",
								params: {
									token: "rustAnalyzer/Fetching",
									value: { kind: "end" },
								},
							});
						}, 10);
						return;
					}

					if (workspaceSymbolRequests === 2) {
						controls.emit({
							jsonrpc: "2.0",
							method: "$/progress",
							params: {
								token: "rustAnalyzer/Roots Scanned",
								value: { kind: "begin", title: "Roots Scanned" },
							},
						});
						controls.emit({ jsonrpc: "2.0", id: message.id, result: null });
						setTimeout(() => {
							controls.emit({
								jsonrpc: "2.0",
								method: "$/progress",
								params: {
									token: "rustAnalyzer/Roots Scanned",
									value: { kind: "end" },
								},
							});
						}, 10);
						return;
					}

					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: [{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }],
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 300 });
		await runtime.start({ command: ["dummy-lsp"] });

		const result = await runtime.request("workspace/symbol", { query: "VoxelWorldPlugin" }, 300);
		expect(result).toEqual([{ name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }, { name: "VoxelWorldPlugin" }]);
		expect(workspaceSymbolRequests).toBe(3);

		await runtime.stop();
	});

	it("sends outgoing didOpen and didChange notifications", async () => {
		const messages: JsonRpcMessage[] = [];
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				messages.push(message);
				if (message.method === "initialize") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					});
					return;
				}

				if (message.method === "shutdown") {
					controls.emit({
						jsonrpc: "2.0",
						id: message.id,
						result: null,
					});
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		await runtime.start({ command: ["dummy-lsp"] });

		const notify = Reflect.get(runtime, "notify");
		expect(typeof notify).toBe("function");
		if (typeof notify !== "function") {
			throw new Error("notify is not implemented");
		}

		notify.call(runtime, "textDocument/didOpen", {
			textDocument: {
				uri: "file:///workspace/main.ts",
				languageId: "typescript",
				version: 1,
				text: "export const value = 1;\n",
			},
		});
		notify.call(runtime, "textDocument/didChange", {
			textDocument: {
				uri: "file:///workspace/main.ts",
				version: 2,
			},
			contentChanges: [{ text: "export const value = 2;\n" }],
		});

		expect(messages.slice(-2)).toEqual([
			{
				jsonrpc: "2.0",
				method: "textDocument/didOpen",
				params: {
					textDocument: {
						uri: "file:///workspace/main.ts",
						languageId: "typescript",
						version: 1,
						text: "export const value = 1;\n",
					},
				},
			},
			{
				jsonrpc: "2.0",
				method: "textDocument/didChange",
				params: {
					textDocument: {
						uri: "file:///workspace/main.ts",
						version: 2,
					},
					contentChanges: [{ text: "export const value = 2;\n" }],
				},
			},
		]);

		await runtime.stop();
	});

	it("surfaces stderr when the child exits before initialize completes", async () => {
		const spawn = createMockSpawn({
			onRequest(message, controls) {
				if (message.method === "initialize") {
					controls.emitStderr("error: required option '--stdio' not specified\n");
					controls.exit(1);
				}
			},
		});

		const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
		await runtime.start({ command: ["dummy-lsp"] });

		const status = runtime.getStatus();
		expect(status.state).toBe("error");
		expect(status.reason).toContain("required option '--stdio' not specified");
	});

	it("waits for exited after sending SIGKILL during shutdown", async () => {
		vi.useFakeTimers();
		try {
			let killCalls = 0;
			const spawn = createMockSpawn({
				asyncKillDelayMs: 50,
				ignoreStdinEnd: true,
				onRequest(message, controls) {
					if (message.method === "initialize") {
						controls.emit({
							jsonrpc: "2.0",
							id: message.id,
							result: { capabilities: {} },
						});
						return;
					}

					if (message.method === "shutdown") {
						controls.emit({
							jsonrpc: "2.0",
							id: message.id,
							result: null,
						});
					}
				},
				onKill() {
					killCalls += 1;
				},
			});

			const runtime = createLspClientRuntime({ spawn, requestTimeoutMs: 200 });
			await runtime.start({ command: ["dummy-lsp"] });

			let resolved = false;
			const stopPromise = runtime.stop().then(() => {
				resolved = true;
			});

			await vi.advanceTimersByTimeAsync(1_000);
			expect(killCalls).toBe(1);
			expect(resolved).toBe(false);

			await vi.advanceTimersByTimeAsync(50);
			await stopPromise;
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

function createMockSpawn(options: CreateMockSpawnOptions = {}): LspSpawn {
	return (_command, spawnOptions) => {
		let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let resolveExited: ((code: number | null) => void) | undefined;
		const exited = new Promise<number | null>((resolve) => {
			resolveExited = resolve;
		});

		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				stdoutController = controller;
			},
		});
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				stderrController = controller;
			},
		});

		const controls: MockSpawnControls = {
			emit(payload) {
				if (!stdoutController) {
					return;
				}
				const json = JSON.stringify(payload);
				const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
				stdoutController.enqueue(new TextEncoder().encode(frame));
			},
			emitStderr(text) {
				stderrController?.enqueue(new TextEncoder().encode(text));
			},
			exit(code) {
				resolveExited?.(code);
				stdoutController?.close();
				stderrController?.close();
			},
		};

		options.onSpawn?.(spawnOptions, controls);

		return {
			pid: 4242,
			stdin: {
				write(data) {
					const message = parseOutgoingMessage(data);
					if (message) {
						options.onRequest?.(message, controls);
					}
					return undefined;
				},
				end() {
					if (!options.ignoreStdinEnd) {
						controls.exit(0);
					}
					return undefined;
				},
			},
			stdout,
			stderr,
			exited,
			kill() {
				options.onKill?.();
				if (options.asyncKillDelayMs !== undefined) {
					setTimeout(() => controls.exit(0), options.asyncKillDelayMs);
				} else {
					controls.exit(0);
				}
				return undefined;
			},
		};
	};
}

function parseOutgoingMessage(data: string | Uint8Array): JsonRpcMessage | undefined {
	const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
	const separatorIndex = raw.indexOf("\r\n\r\n");
	if (separatorIndex === -1) {
		return undefined;
	}

	const payload = raw.slice(separatorIndex + 4);
	if (!payload.trim()) {
		return undefined;
	}

	try {
		return JSON.parse(payload) as JsonRpcMessage;
	} catch {
		return undefined;
	}
}
