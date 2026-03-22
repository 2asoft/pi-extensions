import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspConfigResolver } from "../src/config/resolver.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createExecutable(filePath: string): void {
	writeFileSync(filePath, "#!/usr/bin/env node\n", "utf8");
	chmodSync(filePath, 0o755);
}

function assertDefaultServer(
	config: ReturnType<ReturnType<typeof createLspConfigResolver>["resolve"]>,
	command: string[],
): void {
	expect(config.servers).toEqual([{ name: "default", command }]);
}

function isolatedEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: "",
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lsp config resolver", () => {
	it("auto-detects typescript with built-in --stdio args when project markers exist", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		const pathDir = createTempDir("lsp-path-");
		createExecutable(join(pathDir, "typescript-language-server"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: {
				...isolatedEnv(),
				PATH: pathDir,
			},
		});

		const config = resolver.resolve();
		expect(config.servers).toMatchObject([
			{
				name: "typescript",
				command: [join(pathDir, "typescript-language-server"), "--stdio"],
				fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
			},
		]);
		expect(config.serverCommand).toEqual([join(pathDir, "typescript-language-server"), "--stdio"]);
	});

	it("does not auto-detect a provider when the workspace lacks its root markers", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		const pathDir = createTempDir("lsp-path-");
		createExecutable(join(pathDir, "typescript-language-server"));

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: {
				...isolatedEnv(),
				PATH: pathDir,
			},
		});

		const config = resolver.resolve();
		expect(config.servers).toEqual([]);
		expect(config.serverCommand).toBeUndefined();
	});

	it("prefers node_modules/.bin over PATH for typescript-language-server", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		const pathDir = createTempDir("lsp-path-");
		const localBinDir = join(cwd, "node_modules", ".bin");
		mkdirSync(localBinDir, { recursive: true });
		createExecutable(join(pathDir, "typescript-language-server"));
		createExecutable(join(localBinDir, "typescript-language-server"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: {
				...isolatedEnv(),
				PATH: pathDir,
			},
		});

		const config = resolver.resolve();
		expect(config.servers[0]).toMatchObject({
			name: "typescript",
			command: [join(localBinDir, "typescript-language-server"), "--stdio"],
		});
	});

	it("prefers .venv/bin over PATH for python language servers", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		const pathDir = createTempDir("lsp-path-");
		const localBinDir = join(cwd, ".venv", "bin");
		mkdirSync(localBinDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		createExecutable(join(pathDir, "pyright-langserver"));
		createExecutable(join(localBinDir, "pyright-langserver"));
		writeFileSync(join(cwd, "pyproject.toml"), '[project]\nname = "fixture"\n', "utf8");
		writeFileSync(
			join(cwd, ".pi", "lsp.json"),
			JSON.stringify({
				serverCommand: ["pyright-langserver"],
			}),
			"utf8",
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: {
				...isolatedEnv(),
				PATH: pathDir,
			},
		});

		const config = resolver.resolve();
		expect(config.serverCommand).toEqual([join(localBinDir, "pyright-langserver")]);
		assertDefaultServer(config, [join(localBinDir, "pyright-langserver")]);
	});

	it("suppresses typescript when deno markers exist", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		const pathDir = createTempDir("lsp-path-");
		createExecutable(join(pathDir, "typescript-language-server"));
		createExecutable(join(pathDir, "deno"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
		writeFileSync(join(cwd, "deno.json"), JSON.stringify({ tasks: {} }), "utf8");

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: {
				...isolatedEnv(),
				PATH: pathDir,
			},
		});

		const config = resolver.resolve();
		expect(config.servers).toMatchObject([
			{
				name: "deno",
				command: [join(pathDir, "deno"), "lsp"],
				fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
			},
		]);
		expect(config.serverCommand).toEqual([join(pathDir, "deno"), "lsp"]);
	});

	it("resolves multi-server config entries with file-type routing metadata", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							fileTypes: [".ts", ".tsx"],
						},
						py: {
							server: process.execPath,
							fileTypes: [".py"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toHaveLength(2);
		expect(config.serverCommand).toEqual([process.execPath]);
		expect(config.servers[0]).toMatchObject({
			name: "ts",
			command: [process.execPath],
			fileTypes: [".ts", ".tsx"],
		});
		expect(config.servers[1]).toMatchObject({
			name: "py",
			command: [process.execPath],
			fileTypes: [".py"],
		});
	});

	it("allows project config to override user server metadata by name", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							fileTypes: [".ts"],
						},
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(cwd, ".pi", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							fileTypes: [".tsx"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0]).toMatchObject({
			name: "ts",
			command: [process.execPath],
			fileTypes: [".tsx"],
		});
	});

	it("preserves disabled=true when project override only updates metadata", () => {
		const home = createTempDir("lsp-home-");
		const cwd = createTempDir("lsp-cwd-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		writeFileSync(
			join(home, ".pi", "agent", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							command: [process.execPath],
							disabled: true,
							fileTypes: [".ts"],
						},
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(cwd, ".pi", "lsp.json"),
			JSON.stringify(
				{
					servers: {
						ts: {
							fileTypes: [".tsx"],
						},
					},
				},
				null,
				2,
			),
		);

		const resolver = createLspConfigResolver({
			homeDir: home,
			cwd,
			env: isolatedEnv(),
		});

		const config = resolver.resolve();
		expect(config.servers).toEqual([]);
		expect(config.serverCommand).toBeUndefined();
	});
});
