import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";

type PiBashParams = {
	command: string;
	cwd?: string;
	timeoutMs?: number;
	bashPath?: string;
};

type ProcessResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 50_000;

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function normalizeWindowsPath(path: string): string {
	return path.trim().replace(/^@/, "").replace(/\//g, "\\");
}

function uniqueValues(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function looksLikeWindowsShim(path: string): boolean {
	const normalized = normalizeWindowsPath(path).toLowerCase();
	return normalized.endsWith("\\windows\\system32\\bash.exe") || normalized.endsWith("\\windows\\syswow64\\bash.exe");
}

function looksLikeGitPath(path: string): boolean {
	const normalized = normalizeWindowsPath(path).toLowerCase();
	return normalized.includes("\\git\\") || normalized.includes("\\portablegit\\") || normalized.includes("git-bash");
}

function candidateScore(path: string): number {
	const normalized = normalizeWindowsPath(path).toLowerCase();
	let score = 0;
	if (looksLikeGitPath(normalized)) score += 100;
	if (normalized.endsWith("\\bin\\bash.exe")) score += 20;
	if (normalized.endsWith("\\usr\\bin\\bash.exe")) score += 10;
	return score;
}

function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abortHandler);
		};

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const killChild = () => {
			if (!child.killed) child.kill("SIGTERM");
		};

		const timeoutId = setTimeout(() => {
			timedOut = true;
			killChild();
		}, timeoutMs);

		const abortHandler = () => killChild();
		signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", fail);
		child.on("close", (exitCode, childSignal) => {
			finish({ stdout, stderr, exitCode, signal: childSignal, timedOut });
		});
	});
}

async function where(command: string): Promise<string[]> {
	try {
		const result = await runProcess("where.exe", [command], 10_000);
		return uniqueValues(
			result.stdout
				.split(/\r?\n/)
				.map((line) => normalizeWindowsPath(line))
				.filter(Boolean),
		);
	} catch {
		return [];
	}
}

function deriveBashPathsFromGit(gitPath: string): string[] {
	const normalized = normalizeWindowsPath(gitPath);
	const gitDir = dirname(normalized);
	const root = dirname(gitDir);
	return uniqueValues([
		join(root, "bin", "bash.exe"),
		join(root, "usr", "bin", "bash.exe"),
		join(gitDir, "bash.exe"),
	]);
}

async function findBashCandidates(): Promise<{ candidates: string[]; skipped: string[]; whereBash: string[]; whereGit: string[] }> {
	const whereBash = await where("bash.exe");
	const whereGit = await where("git.exe");
	const skipped = whereBash.filter(looksLikeWindowsShim);
	const directCandidates = whereBash.filter((path) => !looksLikeWindowsShim(path));
	const derivedCandidates = whereGit.flatMap(deriveBashPathsFromGit);
	const existingDerivedCandidates: string[] = [];

	for (const candidate of derivedCandidates) {
		if (await fileExists(candidate)) existingDerivedCandidates.push(candidate);
	}

	const candidates = uniqueValues([...directCandidates, ...existingDerivedCandidates])
		.filter((candidate) => !looksLikeWindowsShim(candidate))
		.sort((left, right) => candidateScore(right) - candidateScore(left) || left.localeCompare(right));

	return { candidates, skipped, whereBash, whereGit };
}

async function resolveGitBashPath(explicitPath?: string): Promise<{ bashPath: string; discovery?: Awaited<ReturnType<typeof findBashCandidates>> }> {
	if (explicitPath?.trim()) {
		const normalized = normalizeWindowsPath(explicitPath);
		if (looksLikeWindowsShim(normalized)) {
			throw new Error(`Refusing Windows WSL shim, not Git Bash: ${normalized}`);
		}
		if (await fileExists(normalized)) {
			return { bashPath: normalized };
		}

		throw new Error(`Git Bash executable was not found or could not be launched: ${normalized}`);
	}

	const discovery = await findBashCandidates();
	const bashPath = discovery.candidates[0];
	if (bashPath) return { bashPath, discovery };

	throw new Error(
		`No usable Git Bash bash.exe found via where.exe. where bash.exe: ${discovery.whereBash.join(", ") || "none"}. where git.exe: ${discovery.whereGit.join(", ") || "none"}. Skipped Windows shim(s): ${discovery.skipped.join(", ") || "none"}. Pass bashPath if Git Bash is not on PATH.`,
	);
}

function truncateOutput(value: string): { text: string; truncated: boolean; originalLength: number } {
	if (value.length <= MAX_OUTPUT_CHARS) {
		return { text: value, truncated: false, originalLength: value.length };
	}

	return {
		text: `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated to ${MAX_OUTPUT_CHARS} characters from ${value.length}.]`,
		truncated: true,
		originalLength: value.length,
	};
}

function runGitBash(command: string, cwd: string, bashPath: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bashPath, ["-lc", command], { cwd, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abortHandler);
		};

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const killChild = () => {
			if (!child.killed) child.kill("SIGTERM");
		};

		const timeoutId = setTimeout(() => {
			timedOut = true;
			killChild();
		}, timeoutMs);

		const abortHandler = () => killChild();
		signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				fail(new Error(`Git Bash executable was not found or could not be launched: ${bashPath}`));
				return;
			}
			fail(error);
		});

		child.on("close", (exitCode, childSignal) => {
			finish({ stdout, stderr, exitCode, signal: childSignal, timedOut });
		});
	});
}

function formatToolText(result: ProcessResult, cwd: string, bashPath: string): string {
	const stdout = truncateOutput(result.stdout);
	const stderr = truncateOutput(result.stderr);
	const status = result.timedOut ? "timed out" : result.exitCode === 0 ? "ok" : "non-zero exit";
	const parts = [
		`status: ${status}`,
		`cwd: ${cwd}`,
		`bashPath: ${bashPath}`,
		`exitCode: ${result.exitCode ?? "null"}`,
		`timedOut: ${result.timedOut ? "true" : "false"}`,
	];

	if (result.signal) parts.push(`signal: ${result.signal}`);
	parts.push("", "stdout:", stdout.text || "<empty>", "", "stderr:", stderr.text || "<empty>");
	return parts.join("\n");
}

function registerFindTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi_bash_find",
		label: "Find Git Bash",
		description: "Find Git Bash using where.exe bash.exe and where.exe git.exe. Use this to diagnose pi_bash discovery on Windows.",
		promptSnippet: "On Windows, use pi_bash_find to diagnose Git Bash discovery for pi_bash.",
		promptGuidelines: [
			"Use pi_bash_find when pi_bash cannot locate Git Bash or when you need to show the selected bash.exe path.",
			"Do not use the built-in bash tool for this diagnostic on Windows because it may route to WSL.",
		],
		parameters: Type.Object({}),
		async execute() {
			if (platform() !== "win32") throw new Error("pi_bash_find is only supported from Windows.");
			const discovery = await findBashCandidates();
			const text = [
				"candidates:",
				...(discovery.candidates.length ? discovery.candidates.map((candidate) => `- ${candidate}`) : ["<none>"]),
				"",
				"where bash.exe:",
				...(discovery.whereBash.length ? discovery.whereBash.map((candidate) => `- ${candidate}`) : ["<none>"]),
				"",
				"where git.exe:",
				...(discovery.whereGit.length ? discovery.whereGit.map((candidate) => `- ${candidate}`) : ["<none>"]),
				"",
				"skipped Windows shims:",
				...(discovery.skipped.length ? discovery.skipped.map((candidate) => `- ${candidate}`) : ["<none>"]),
			].join("\n");

			return { content: [{ type: "text", text }], details: discovery };
		},
	});
}

function registerGitBashTool(pi: ExtensionAPI, name: string, label: string) {
	pi.registerTool({
		name,
		label,
		description:
			"Default Windows shell runner for Pi. Run shell commands through Git Bash on Windows. Finds bash.exe using where.exe bash.exe/git.exe, excludes Windows WSL shims, then runs bash.exe -lc <command> in the Windows cwd.",
		promptSnippet: "On Windows, use pi_bash as the default shell command runner instead of the built-in bash tool.",
		promptGuidelines: [
			`Prefer ${name} for all shell commands on Windows, including file listing, git, npm, node, npx, test, build, and CLI commands.`,
			`Do not use the built-in bash tool on Windows when ${name} is available because it may route to WSL and fail.`,
			`${name} uses where.exe to find Git Bash and ignores Windows System32 WSL shims.`,
			`Only use the built-in bash tool if ${name} is unavailable or the user explicitly asks for it.`,
		],
		parameters: Type.Object({
			command: Type.String({ description: "Single shell command string executed by bash.exe -lc." }),
			cwd: Type.Optional(Type.String({ description: "Optional Windows working directory. Defaults to the current pi cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 120000." })),
			bashPath: Type.Optional(Type.String({ description: "Optional explicit path to Git Bash bash.exe." })),
		}),
		async execute(_toolCallId, params: PiBashParams, signal, _onUpdate, ctx) {
			if (platform() !== "win32") throw new Error(`${name} is only supported from Windows because it invokes bash.exe.`);

			const command = params.command.trim();
			if (!command) throw new Error("command is required");

			const cwd = params.cwd?.trim() || ctx.cwd;
			const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
			const { bashPath, discovery } = await resolveGitBashPath(params.bashPath);
			const result = await runGitBash(command, cwd, bashPath, timeoutMs, signal);
			const stdout = truncateOutput(result.stdout);
			const stderr = truncateOutput(result.stderr);

			return {
				content: [{ type: "text", text: formatToolText(result, cwd, bashPath) }],
				details: {
					command,
					cwd,
					bashPath,
					timeoutMs,
					stdout: stdout.text,
					stderr: stderr.text,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					nonZeroExit: result.exitCode !== 0,
					truncated: stdout.truncated || stderr.truncated,
					stdoutOriginalLength: stdout.originalLength,
					stderrOriginalLength: stderr.originalLength,
					discovery,
				},
			};
		},
	});
}

export default function piBashExtension(pi: ExtensionAPI) {
	registerFindTool(pi);
	registerGitBashTool(pi, "pi_bash", "Pi Bash");
	registerGitBashTool(pi, "wsl_bash", "Git Bash Compatibility Alias");
}
