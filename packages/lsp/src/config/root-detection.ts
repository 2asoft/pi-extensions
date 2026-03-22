import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export type LspRootStrategy =
	| { type: "nearest"; markers: string[]; excludeMarkers?: string[] }
	| { type: "go" }
	| { type: "rust" }
	| { type: "typescript" }
	| { type: "fallback-cwd" };

export interface RootLookupOptions {
	fromPath: string;
	markers: string[];
	excludeMarkers?: string[];
	stopAt?: string;
}

export function findNearestRoot(options: RootLookupOptions): string | undefined {
	const startDirectory = getStartDirectory(options.fromPath);
	const stopDirectory = options.stopAt ? resolve(options.stopAt) : undefined;

	if (options.excludeMarkers && hasMarkerOnPath(startDirectory, options.excludeMarkers, stopDirectory)) {
		return undefined;
	}

	return findFirstMatchingDirectory(startDirectory, options.markers, stopDirectory);
}

export function resolveRoot(strategy: LspRootStrategy, filePath: string, workspaceRoot: string): string | undefined {
	const normalizedWorkspaceRoot = resolve(workspaceRoot);

	switch (strategy.type) {
		case "nearest":
			return findNearestRoot({
				fromPath: filePath,
				markers: strategy.markers,
				excludeMarkers: strategy.excludeMarkers,
				stopAt: normalizedWorkspaceRoot,
			});
		case "go": {
			const goWorkRoot = findNearestRoot({
				fromPath: filePath,
				markers: ["go.work"],
				stopAt: normalizedWorkspaceRoot,
			});
			if (goWorkRoot) {
				return goWorkRoot;
			}
			return findNearestRoot({
				fromPath: filePath,
				markers: ["go.mod", "go.sum"],
				stopAt: normalizedWorkspaceRoot,
			});
		}
		case "rust":
			return resolveRustRoot(filePath, normalizedWorkspaceRoot);
		case "typescript":
			return resolveTypescriptRoot(filePath, normalizedWorkspaceRoot);
		case "fallback-cwd":
			return normalizedWorkspaceRoot;
	}
}

export function hasAnyMarkerInWorkspace(workspaceRoot: string, markers: string[]): boolean {
	if (markers.length === 0) {
		return true;
	}

	return containsAnyMarker(resolve(workspaceRoot), markers);
}

function resolveRustRoot(filePath: string, workspaceRoot: string): string | undefined {
	const crateRoot = findNearestRoot({
		fromPath: filePath,
		markers: ["Cargo.toml", "Cargo.lock"],
		stopAt: workspaceRoot,
	});
	if (!crateRoot) {
		return undefined;
	}

	let currentDirectory = crateRoot;
	let resolvedRoot = crateRoot;

	while (true) {
		if (isCargoWorkspace(currentDirectory)) {
			resolvedRoot = currentDirectory;
		}

		if (isSamePath(currentDirectory, workspaceRoot)) {
			return resolvedRoot;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return resolvedRoot;
		}

		currentDirectory = parentDirectory;
	}
}

function resolveTypescriptRoot(filePath: string, workspaceRoot: string): string | undefined {
	const denoRoot = findNearestRoot({
		fromPath: filePath,
		markers: ["deno.json", "deno.jsonc"],
		stopAt: workspaceRoot,
	});
	if (denoRoot) {
		return undefined;
	}

	return findNearestRoot({
		fromPath: filePath,
		markers: ["package.json", "tsconfig.json", "jsconfig.json"],
		stopAt: workspaceRoot,
	});
}

function getStartDirectory(fromPath: string): string {
	const resolvedPath = resolve(fromPath);
	if (!existsSync(resolvedPath)) {
		return extname(resolvedPath) ? dirname(resolvedPath) : resolvedPath;
	}

	const stats = statSync(resolvedPath);
	return stats.isDirectory() ? resolvedPath : dirname(resolvedPath);
}

function findFirstMatchingDirectory(
	startDirectory: string,
	markers: string[],
	stopDirectory?: string,
): string | undefined {
	let currentDirectory = startDirectory;

	while (true) {
		if (containsAnyMarker(currentDirectory, markers)) {
			return currentDirectory;
		}

		if (stopDirectory && isSamePath(currentDirectory, stopDirectory)) {
			return undefined;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}
		currentDirectory = parentDirectory;
	}
}

function hasMarkerOnPath(startDirectory: string, markers: string[], stopDirectory?: string): boolean {
	let currentDirectory = startDirectory;

	while (true) {
		if (containsAnyMarker(currentDirectory, markers)) {
			return true;
		}

		if (stopDirectory && isSamePath(currentDirectory, stopDirectory)) {
			return false;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return false;
		}
		currentDirectory = parentDirectory;
	}
}

function containsAnyMarker(directory: string, markers: string[]): boolean {
	for (const marker of markers) {
		if (existsSync(resolve(directory, marker))) {
			return true;
		}
	}
	return false;
}

function isCargoWorkspace(directory: string): boolean {
	const cargoTomlPath = resolve(directory, "Cargo.toml");
	if (!existsSync(cargoTomlPath)) {
		return false;
	}

	try {
		return readFileSync(cargoTomlPath, "utf8").includes("[workspace]");
	} catch {
		return false;
	}
}

function isSamePath(left: string, right: string): boolean {
	if (process.platform === "win32") {
		return left.toLowerCase() === right.toLowerCase();
	}
	return left === right;
}
