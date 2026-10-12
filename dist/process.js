import { spawn } from "node:child_process";
const MAX_CAPTURE_CHARS = 1_000_000;
const OUTPUT_TRUNCATION_MARKER = "\n[agent-bench: process output truncated]\n";
function appendOutput(current, chunk) {
    const combined = current + chunk;
    if (combined.length <= MAX_CAPTURE_CHARS)
        return combined;
    const half = Math.floor((MAX_CAPTURE_CHARS - OUTPUT_TRUNCATION_MARKER.length) / 2);
    return `${combined.slice(0, half)}${OUTPUT_TRUNCATION_MARKER}${combined.slice(-half)}`;
}
const SAFE_ENVIRONMENT = new Set([
    "path", "pathext", "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "tmpdir", "home", "userprofile",
    "appdata", "localappdata", "homedrive", "homepath", "shell", "lang", "lc_all", "xdg_config_home",
    "xdg_cache_home", "xdg_data_home", "codex_home", "claude_config_dir", "ssl_cert_file", "ssl_cert_dir",
    "ci", "github_workspace", "runner_os", "runner_temp", "github_run_id",
]);
function inheritedEnvironment(allowAll) {
    if (allowAll)
        return process.env;
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => SAFE_ENVIRONMENT.has(key.toLowerCase())));
}
function killProcessTree(child, signal) {
    if (!child.pid)
        return;
    if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        killer.on("error", () => child.kill(signal));
        return;
    }
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        child.kill(signal);
    }
}
export function runProcess(command, args, options) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...inheritedEnvironment(options.inheritEnv !== false), ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
            shell: options.shell ?? false,
            detached: process.platform !== "win32",
            windowsHide: true,
        });
        let killTimer;
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child, "SIGTERM");
            killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
        }, options.timeoutMs);
        child.stdout.setEncoding("utf8").on("data", (x) => { stdout = appendOutput(stdout, x); });
        child.stderr.setEncoding("utf8").on("data", (x) => { stderr = appendOutput(stderr, x); });
        child.on("error", (e) => { clearTimeout(timer); if (killTimer)
            clearTimeout(killTimer); reject(e); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - started, timedOut });
        });
        if (options.stdin !== undefined)
            child.stdin.end(options.stdin);
        else
            child.stdin.end();
    });
}
export function parseTokens(output, parser) {
    if (!parser || parser === "none")
        return null;
    if (parser === "codex-jsonl") {
        let found = null;
        for (const line of output.split(/\r?\n/)) {
            try {
                const item = JSON.parse(line);
                const usage = item.usage;
                const n = typeof usage?.total_tokens === "number"
                    ? usage.total_tokens
                    : typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
                        ? usage.input_tokens + usage.output_tokens
                        : item.payload?.info?.total_token_usage?.total_tokens;
                if (typeof n === "number")
                    found = n;
            }
            catch { /* Ignore non-JSON diagnostic lines. */ }
        }
        return found;
    }
    if (parser === "claude-json") {
        try {
            const result = JSON.parse(output);
            if (typeof result.usage?.input_tokens === "number" && typeof result.usage.output_tokens === "number") {
                return result.usage.input_tokens + result.usage.output_tokens;
            }
        }
        catch { /* The agent may have returned plain text or streaming JSON. */ }
    }
    return null;
}
export function parseIterations(output, parser) {
    if (parser === "codex-jsonl") {
        let count = 0;
        let foundTurnEvents = false;
        for (const line of output.split(/\r?\n/)) {
            try {
                const item = JSON.parse(line);
                if (item.type === "turn.completed") {
                    count += 1;
                    foundTurnEvents = true;
                }
            }
            catch { /* Ignore non-JSON diagnostic lines. */ }
        }
        return foundTurnEvents ? count : null;
    }
    if (parser === "claude-json") {
        try {
            const result = JSON.parse(output);
            return typeof result.num_turns === "number" ? result.num_turns : null;
        }
        catch { /* The agent may have returned plain text or streaming JSON. */ }
    }
    return null;
}
