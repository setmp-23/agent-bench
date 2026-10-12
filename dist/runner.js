import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { parseIterations, parseTokens, runProcess } from "./process.js";
const OMIT = new Set([
    ".git", "node_modules", "dist", ".agent-bench", "benchmark-results", ".aws", ".azure", ".ssh", ".gnupg", ".kube",
    ".venv", "venv", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage",
]);
const SECRET_FILE = /^(?:\.env(?:\.(?!example$).*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519)$/i;
const PRIVATE_KEY_FILE = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const excerpt = (s) => s.trim().slice(-1800);
function isExcluded(relative) {
    return relative.split(path.sep).some((part) => OMIT.has(part) || SECRET_FILE.test(part) || PRIVATE_KEY_FILE.test(part));
}
async function resolveRepository(source) {
    const root = await realpath(source);
    async function inspect(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (isExcluded(entry.name))
                continue;
            const file = path.join(directory, entry.name);
            const info = await lstat(file);
            if (info.isSymbolicLink()) {
                const target = await realpath(file);
                const relative = path.relative(root, target);
                if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                    throw new Error(`Repository symlink points outside the repository: ${file}`);
                }
                if (relative.split(path.sep).some((part) => isExcluded(part))) {
                    throw new Error(`Repository symlink points into an excluded directory: ${file}`);
                }
                if (!(await stat(target)).isFile()) {
                    throw new Error(`Directory and special-file symlinks are not supported: ${file}`);
                }
            }
            else if (info.isDirectory()) {
                await inspect(file);
            }
        }
    }
    await inspect(root);
    return root;
}
async function freshCopy(source, destination) {
    await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: (entry) => {
            const relative = path.relative(source, entry);
            if (!relative)
                return true;
            return !isExcluded(relative);
        },
    });
}
async function initializeWorkspace(workspace) {
    const hooks = path.join(path.dirname(workspace), "empty-hooks");
    await mkdir(hooks);
    const init = await runProcess("git", ["init", "--quiet", `--template=${hooks}`], { cwd: workspace, timeoutMs: 30_000, inheritEnv: false });
    if (init.code !== 0)
        throw new Error(`git init failed: ${excerpt(init.stderr)}`);
    const hooksConfig = await runProcess("git", ["config", "core.hooksPath", hooks], { cwd: workspace, timeoutMs: 30_000, inheritEnv: false });
    if (hooksConfig.code !== 0)
        throw new Error(`Could not configure the task snapshot: ${excerpt(hooksConfig.stderr)}`);
    const userConfig = await runProcess("git", ["config", "user.name", "agent-bench"], { cwd: workspace, timeoutMs: 30_000, inheritEnv: false });
    if (userConfig.code !== 0)
        throw new Error(`Could not configure the task snapshot: ${excerpt(userConfig.stderr)}`);
    const emailConfig = await runProcess("git", ["config", "user.email", "agent-bench@localhost"], { cwd: workspace, timeoutMs: 30_000, inheritEnv: false });
    if (emailConfig.code !== 0)
        throw new Error(`Could not configure the task snapshot: ${excerpt(emailConfig.stderr)}`);
    const add = await runProcess("git", ["add", "--all"], { cwd: workspace, timeoutMs: 60_000, inheritEnv: false });
    if (add.code !== 0)
        throw new Error(`Could not prepare task snapshot: ${excerpt(add.stderr)}`);
    const commit = await runProcess("git", ["commit", "--quiet", "--allow-empty", "-m", "benchmark baseline"], { cwd: workspace, timeoutMs: 60_000, inheritEnv: false });
    if (commit.code !== 0)
        throw new Error(`Could not prepare task snapshot: ${excerpt(commit.stderr)}`);
}
function expand(value, prompt, workspace) {
    return value.replaceAll("{prompt}", prompt).replaceAll("{workspace}", workspace);
}
function expandAgentEnv(value, prompt, workspace) {
    return expand(value, prompt, workspace).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
        const envValue = process.env[name];
        if (envValue === undefined)
            throw new Error(`Environment variable ${name} is not set`);
        return envValue;
    });
}
async function runCheck(check, cwd, workspace, benchmarkRoot) {
    const started = Date.now();
    const command = check.run.replaceAll("{workspace}", workspace).replaceAll("{benchmark}", benchmarkRoot);
    let result;
    try {
        result = await runProcess(command, [], {
            cwd, timeoutMs: (check.timeoutSeconds ?? 60) * 1000, shell: true, inheritEnv: false,
        });
    }
    catch (error) {
        return { name: check.name, passed: false, durationMs: Date.now() - started, output: String(error) };
    }
    return {
        name: check.name,
        passed: result.code === 0 && !result.timedOut,
        durationMs: result.durationMs,
        output: excerpt(`${result.stdout}\n${result.stderr}${result.timedOut ? "\nTimed out" : ""}`),
    };
}
async function runTask(agent, task, base, benchmarkRoot, checkDir, timeoutSeconds) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "agent-bench-"));
    const workspace = path.join(temp, "workspace");
    const started = Date.now();
    try {
        await freshCopy(base, workspace);
        const cwd = path.resolve(workspace, checkDir || ".");
        const relativeCwd = path.relative(workspace, cwd);
        if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
            throw new Error("workdir must stay inside the benchmark workspace");
        }
        await initializeWorkspace(workspace);
        const args = agent.args.map((arg) => expand(arg, task.prompt, workspace));
        const env = {};
        for (const [key, value] of Object.entries(agent.env ?? {}))
            env[key] = expandAgentEnv(value, task.prompt, workspace);
        let proc;
        let spawnError;
        try {
            proc = await runProcess(agent.command, args, {
                cwd,
                env,
                inheritEnv: agent.inheritEnv,
                timeoutMs: (agent.timeoutSeconds ?? timeoutSeconds) * 1000,
                stdin: agent.args.some((x) => x.includes("{prompt}")) ? undefined : task.prompt,
            });
        }
        catch (error) {
            spawnError = String(error);
            proc = { code: 1, stdout: "", stderr: String(error), durationMs: 0, timedOut: false };
        }
        const checks = [];
        for (const check of task.checks)
            checks.push(await runCheck(check, cwd, workspace, benchmarkRoot));
        const passed = proc.code === 0 && !proc.timedOut && checks.length > 0 && checks.every((x) => x.passed);
        const error = proc.timedOut
            ? `Agent timed out after ${agent.timeoutSeconds ?? timeoutSeconds}s`
            : spawnError
                ? `Could not start agent: ${spawnError}`
                : proc.code !== 0
                    ? `Agent exited with code ${proc.code}`
                    : undefined;
        return {
            taskId: task.id,
            passed,
            checks,
            durationMs: Date.now() - started,
            tokens: parseTokens(proc.stdout, agent.tokenParser),
            iterations: parseIterations(proc.stdout, agent.tokenParser),
            ...(error ? { error } : {}),
        };
    }
    catch (e) {
        return { taskId: task.id, passed: false, checks: [], durationMs: Date.now() - started, tokens: null, iterations: null, error: String(e) };
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
}
function scoreAgent(agent, tasks, results) {
    const byId = new Map(results.map((r) => [r.taskId, r]));
    const taskWeight = tasks.reduce((n, t) => n + (t.weight ?? 1), 0) || 1;
    const passedWeight = tasks.reduce((n, t) => n + (byId.get(t.id)?.passed ? t.weight ?? 1 : 0), 0);
    let checkTotal = 0;
    let checkPassed = 0;
    for (const task of tasks) {
        const weight = task.weight ?? 1;
        for (const check of task.checks) {
            const checkWeight = weight * (check.weight ?? 1);
            checkTotal += checkWeight;
            if (byId.get(task.id)?.checks.find((x) => x.name === check.name)?.passed)
                checkPassed += checkWeight;
        }
    }
    const successRate = 100 * passedWeight / taskWeight;
    const checkRate = checkTotal ? 100 * checkPassed / checkTotal : 0;
    const tokens = results.some((r) => r.tokens !== null) ? results.reduce((n, r) => n + (r.tokens ?? 0), 0) : null;
    const iterations = results.some((r) => r.iterations !== null) ? results.reduce((n, r) => n + (r.iterations ?? 0), 0) : null;
    return {
        agentId: agent.id,
        name: agent.name ?? agent.id,
        score: Math.round((0.7 * successRate + 0.3 * checkRate) * 100) / 100,
        successRate: Math.round(successRate * 100) / 100,
        checkRate: Math.round(checkRate * 100) / 100,
        durationMs: results.reduce((n, r) => n + r.durationMs, 0),
        tokens,
        iterations,
        tasks: results,
    };
}
function escapeCell(value) {
    return value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}
export function renderMarkdown(report) {
    const lines = ["# agent-bench results", "", `Run: ${report.startedAt}`, "", "| Rank | Agent | Score | Tasks passed | Checks passed | Time | Turns | Tokens |", "|---:|---|---:|---:|---:|---:|---:|---:|"];
    const sorted = [...report.results].sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
    sorted.forEach((r, i) => lines.push(`| ${i + 1} | ${escapeCell(r.name)} | ${r.score.toFixed(2)} | ${r.successRate.toFixed(1)}% | ${r.checkRate.toFixed(1)}% | ${(r.durationMs / 1000).toFixed(1)}s | ${r.iterations ?? "n/a"} | ${r.tokens ?? "n/a"} |`));
    lines.push("", "Scores use 70% weighted task pass rate and 30% weighted acceptance-check pass rate. Time and token usage are reported separately.", "");
    return lines.join("\n");
}
export async function runBenchmark(configFile, outputFile) {
    const { config, file } = await loadConfig(configFile);
    const repositoryPath = path.resolve(path.dirname(file), config.repository ?? ".");
    const repositoryStat = await stat(repositoryPath);
    if (!repositoryStat.isDirectory())
        throw new Error(`Repository must be a directory: ${repositoryPath}`);
    const base = await resolveRepository(repositoryPath);
    const startedAt = new Date().toISOString();
    const results = [];
    for (const agent of config.agents) {
        const taskResults = [];
        for (const task of config.tasks) {
            console.log(`▶ ${agent.name ?? agent.id} / ${task.id}`);
            const result = await runTask(agent, task, base, path.dirname(file), config.workdir ?? ".", 900);
            taskResults.push(result);
            console.log(`  ${result.passed ? "PASS" : "FAIL"} · ${(result.durationMs / 1000).toFixed(1)}s`);
        }
        results.push(scoreAgent(agent, config.tasks, taskResults));
    }
    const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), results };
    const absoluteOutput = path.resolve(outputFile);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(absoluteOutput.replace(/\.json$/i, ".md"), renderMarkdown(report), "utf8");
    return report;
}
export async function writeConfigTemplate(file) {
    const template = {
        version: 1,
        repository: ".",
        agents: [
            { id: "codex", name: "Codex", command: "codex", args: ["exec", "--json", "--full-auto", "{prompt}"], tokenParser: "codex-jsonl" },
            { id: "claude", name: "Claude Code", command: "claude", args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "{prompt}"], tokenParser: "claude-json" },
        ],
        tasks: [{ id: "example", prompt: "Implement the requested change. Keep the patch focused.", checks: [{ name: "project check", run: "npm run check" }] }],
    };
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    try {
        await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    catch (error) {
        if (error.code === "EEXIST") {
            throw new Error(`Refusing to overwrite existing config: ${path.resolve(file)}`);
        }
        throw error;
    }
}
export async function showReport(file) {
    const report = JSON.parse(await readFile(file, "utf8"));
    const validResults = Array.isArray(report?.results) && report.results.every((entry) => entry && typeof entry.agentId === "string" && typeof entry.name === "string" &&
        [entry.score, entry.successRate, entry.checkRate, entry.durationMs].every(Number.isFinite) &&
        (entry.tokens === null || Number.isFinite(entry.tokens)) &&
        (entry.iterations === null || Number.isFinite(entry.iterations)) && Array.isArray(entry.tasks));
    if (report?.schemaVersion !== 1 || typeof report.startedAt !== "string" || !validResults) {
        throw new Error("Unsupported or invalid report file (expected schemaVersion 1 and a results array)");
    }
    console.log(renderMarkdown(report));
}
