import { readFile } from "node:fs/promises";
import path from "node:path";
function assert(condition, message) {
    if (!condition)
        throw new Error(`Invalid benchmark config: ${message}`);
}
function validatePositiveNumber(value, label) {
    assert(value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0), `${label} must be a positive number`);
}
function validateAgent(value, index) {
    const a = value;
    assert(a && typeof a === "object", `agents[${index}] must be an object`);
    assert(typeof a.id === "string" && /^[a-zA-Z0-9_-]+$/.test(a.id), `agents[${index}].id must use letters, numbers, _ or -`);
    assert(typeof a.command === "string" && a.command.trim().length > 0, `agents[${index}].command is required`);
    assert(Array.isArray(a.args) && a.args.every((x) => typeof x === "string"), `agents[${index}].args must be a string array`);
    assert(a.name === undefined || (typeof a.name === "string" && a.name.trim().length > 0), `agents[${index}].name must be a non-empty string`);
    assert(a.tokenParser === undefined || ["codex-jsonl", "claude-json", "none"].includes(a.tokenParser), `agents[${index}].tokenParser is not supported`);
    assert(a.env === undefined || (a.env !== null && typeof a.env === "object" && !Array.isArray(a.env)), `agents[${index}].env must be an object`);
    assert(a.inheritEnv === undefined || typeof a.inheritEnv === "boolean", `agents[${index}].inheritEnv must be a boolean`);
    if (a.env) {
        for (const [key, envValue] of Object.entries(a.env)) {
            assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key), `agents[${index}].env contains an invalid variable name`);
            assert(typeof envValue === "string", `agents[${index}].env.${key} must be a string`);
        }
    }
    validatePositiveNumber(a.timeoutSeconds, `agents[${index}].timeoutSeconds`);
    return { ...a, id: a.id, command: a.command, args: a.args };
}
function validateTask(value, index) {
    const t = value;
    assert(t && typeof t === "object", `tasks[${index}] must be an object`);
    assert(typeof t.id === "string" && /^[a-zA-Z0-9_-]+$/.test(t.id), `tasks[${index}].id must use letters, numbers, _ or -`);
    assert(typeof t.prompt === "string" && t.prompt.length > 0, `tasks[${index}].prompt is required`);
    assert(Array.isArray(t.checks) && t.checks.length > 0, `tasks[${index}].checks must contain at least one check`);
    for (const [i, c] of t.checks.entries()) {
        assert(c && typeof c === "object", `tasks[${index}].checks[${i}] must be an object`);
        assert(typeof c.name === "string" && c.name.trim().length > 0, `tasks[${index}].checks[${i}].name is required`);
        assert(typeof c.run === "string" && c.run.trim().length > 0, `tasks[${index}].checks[${i}].run is required`);
        validatePositiveNumber(c.weight, `tasks[${index}].checks[${i}].weight`);
        validatePositiveNumber(c.timeoutSeconds, `tasks[${index}].checks[${i}].timeoutSeconds`);
    }
    assert(new Set(t.checks.map((c) => c.name)).size === t.checks.length, `tasks[${index}] check names must be unique`);
    validatePositiveNumber(t.weight, `tasks[${index}].weight`);
    return t;
}
export async function loadConfig(file) {
    const absolute = path.resolve(file);
    const raw = JSON.parse(await readFile(absolute, "utf8"));
    const c = raw;
    assert(c && c.version === 1, "version must be 1");
    assert(Array.isArray(c.agents) && c.agents.length > 0, "at least one agent is required");
    assert(Array.isArray(c.tasks) && c.tasks.length > 0, "at least one task is required");
    assert(c.repository === undefined || (typeof c.repository === "string" && c.repository.length > 0), "repository must be a non-empty path string");
    assert(c.workdir === undefined || typeof c.workdir === "string", "workdir must be a relative path string");
    if (c.workdir !== undefined) {
        assert(!path.isAbsolute(c.workdir), "workdir must be relative to the repository");
        const segments = c.workdir.replaceAll("\\", "/").split("/");
        assert(!segments.includes(".."), "workdir cannot leave the repository");
    }
    const agents = c.agents.map(validateAgent);
    const tasks = c.tasks.map(validateTask);
    assert(new Set(agents.map((x) => x.id)).size === agents.length, "agent ids must be unique");
    assert(new Set(tasks.map((x) => x.id)).size === tasks.length, "task ids must be unique");
    return { config: { ...c, agents, tasks }, file: absolute };
}
