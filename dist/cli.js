#!/usr/bin/env node
import path from "node:path";
import { runBenchmark, showReport, writeConfigTemplate } from "./runner.js";
function help() {
    console.log(`agent-bench — reproducible coding-agent benchmarks

Usage:
  agent-bench init [config.json]
  agent-bench run [--config benchmark.config.json] [--output benchmark-results/run.json] [--fail-under 0-100]
  agent-bench leaderboard <run.json>

Commands:
  init         Write a starter configuration
  run          Run configured agents against isolated copies of each task repository
  leaderboard  Print a Markdown leaderboard from a saved run
`);
}
function parseRunArgs(args) {
    const options = { config: "benchmark.config.json", output: "benchmark-results/run.json" };
    const seen = new Set();
    for (let i = 0; i < args.length; i += 1) {
        const flag = args[i];
        if (flag !== "--config" && flag !== "--output" && flag !== "--fail-under")
            throw new Error(`Unknown run option: ${flag}`);
        if (seen.has(flag))
            throw new Error(`Option ${flag} can only be provided once`);
        const value = args[i + 1];
        if (!value || value.startsWith("--"))
            throw new Error(`${flag} needs a path`);
        if (flag === "--config")
            options.config = value;
        else if (flag === "--output")
            options.output = value;
        else {
            const score = Number(value);
            if (!Number.isFinite(score) || score < 0 || score > 100)
                throw new Error("--fail-under must be a number from 0 to 100");
            options.failUnder = score;
        }
        seen.add(flag);
        i += 1;
    }
    return options;
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "--help" || command === "-h")
        return help();
    if (args.includes("--help") || args.includes("-h"))
        return help();
    if (command === "init") {
        if (args.length > 1)
            throw new Error("init accepts at most one config path");
        if (args[0]?.startsWith("--"))
            throw new Error("init expects a file path, not an option");
        const file = args[0] ?? "benchmark.config.json";
        await writeConfigTemplate(file);
        console.log(`Created ${path.resolve(file)}`);
        return;
    }
    if (command === "run") {
        const { config, output, failUnder } = parseRunArgs(args);
        const report = await runBenchmark(config, output);
        console.log(`\nSaved ${path.resolve(output)} and its Markdown summary.`);
        console.log(`Top score: ${[...report.results].sort((a, b) => b.score - a.score)[0]?.name ?? "none"}`);
        const topScore = Math.max(...report.results.map((result) => result.score));
        if (failUnder !== undefined && topScore < failUnder) {
            console.error(`No agent reached the required score of ${failUnder}.`);
            process.exitCode = 1;
        }
        return;
    }
    if (command === "leaderboard") {
        if (args.length !== 1)
            throw new Error("leaderboard requires exactly one run.json path");
        await showReport(args[0]);
        return;
    }
    help();
    process.exitCode = 2;
}
main().catch((error) => {
    console.error(`agent-bench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
