import type { LspRootStrategy } from "./root-detection.js";

export interface BuiltInLspServerDefinition {
	name: string;
	binary: string;
	args?: string[];
	fileTypes: string[];
	rootStrategy: LspRootStrategy;
}

export const builtInLspServerCatalog: readonly BuiltInLspServerDefinition[] = [
	{
		name: "deno",
		binary: "deno",
		args: ["lsp"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
		rootStrategy: {
			type: "nearest",
			markers: ["deno.json", "deno.jsonc"],
		},
	},
	{
		name: "typescript",
		binary: "typescript-language-server",
		args: ["--stdio"],
		fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		rootStrategy: {
			type: "typescript",
		},
	},
	{
		name: "pyright",
		binary: "pyright-langserver",
		args: ["--stdio"],
		fileTypes: [".py", ".pyi"],
		rootStrategy: {
			type: "nearest",
			markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
		},
	},
	{
		name: "yaml",
		binary: "yaml-language-server",
		args: ["--stdio"],
		fileTypes: [".yaml", ".yml"],
		rootStrategy: {
			type: "nearest",
			markers: [
				"docker-compose.yml",
				"docker-compose.yaml",
				"mkdocs.yml",
				"Chart.yaml",
				"chart.yaml",
				"openapi.yaml",
				"openapi.yml",
			],
		},
	},
	{
		name: "rust",
		binary: "rust-analyzer",
		fileTypes: [".rs"],
		rootStrategy: {
			type: "rust",
		},
	},
	{
		name: "gopls",
		binary: "gopls",
		fileTypes: [".go"],
		rootStrategy: {
			type: "go",
		},
	},
	{
		name: "clangd",
		binary: "clangd",
		fileTypes: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
		rootStrategy: {
			type: "nearest",
			markers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"],
		},
	},
	{
		name: "lua",
		binary: "lua-language-server",
		fileTypes: [".lua"],
		rootStrategy: {
			type: "nearest",
			markers: [".luarc.json", ".luarc.jsonc", "stylua.toml"],
		},
	},
] as const;
