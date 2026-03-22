import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRoot } from "../src/config/root-detection.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("root detection", () => {
	it("prefers go.work over go.mod as the root", () => {
		const workspaceRoot = createTempDir("lsp-go-");
		const moduleRoot = join(workspaceRoot, "services", "api");
		const filePath = join(moduleRoot, "cmd", "main.go");
		mkdirSync(join(moduleRoot, "cmd"), { recursive: true });
		writeFileSync(join(workspaceRoot, "go.work"), "go 1.22\nuse ./services/api\n", "utf8");
		writeFileSync(join(moduleRoot, "go.mod"), "module example/api\n", "utf8");
		writeFileSync(filePath, "package main\n", "utf8");

		expect(resolveRoot({ type: "go" }, filePath, workspaceRoot)).toBe(workspaceRoot);
	});

	it("uses the cargo workspace root when an ancestor Cargo.toml declares [workspace]", () => {
		const workspaceRoot = createTempDir("lsp-rust-");
		const crateRoot = join(workspaceRoot, "crates", "core");
		const filePath = join(crateRoot, "src", "lib.rs");
		mkdirSync(join(crateRoot, "src"), { recursive: true });
		writeFileSync(join(workspaceRoot, "Cargo.toml"), '[workspace]\nmembers = ["crates/core"]\n', "utf8");
		writeFileSync(
			join(crateRoot, "Cargo.toml"),
			'[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n',
			"utf8",
		);
		writeFileSync(filePath, "pub fn meaning_of_life() -> i32 { 42 }\n", "utf8");

		expect(resolveRoot({ type: "rust" }, filePath, workspaceRoot)).toBe(workspaceRoot);
	});
});
