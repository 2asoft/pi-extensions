import { describe, expect, it } from "vitest";
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
};

describe("lsp runtime", () => {
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
					controls.exit(0);
					return undefined;
				},
			},
			stdout,
			stderr,
			exited,
			kill() {
				controls.exit(0);
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
