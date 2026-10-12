# agent-bench

[![CI](https://github.com/setmp-23/agent-bench/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/setmp-23/agent-bench/actions/workflows/ci.yml) [![GitHub stars](https://img.shields.io/github/stars/setmp-23/agent-bench?style=social)](https://github.com/setmp-23/agent-bench/stargazers) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`agent-bench` runs command-line coding agents against the same repository tasks, then checks their changes with commands from a JSON config. Each attempt gets a fresh workspace. A run produces JSON details and a Markdown score table.

This is an early version. It measures whether configured checks pass; it does not provide a general measure of code quality. Results are comparable only when the task set, model versions, prompts, limits, and environment are held constant.

## Quick start

Requires Node.js 20+, Git, and the coding-agent CLIs you want to run, already installed and authenticated.

```bash
npm ci
npm run build
node dist/cli.js init
```

Edit `benchmark.config.json` before running it. Set `repository` to the project to benchmark, add task prompts and checks, and configure the agent commands installed on your machine. `repository` is resolved relative to the config file; `workdir`, if set, is relative to that repository.

Then run:

```bash
node dist/cli.js run --config benchmark.config.json
```

Results are saved as `benchmark-results/run.json` and `benchmark-results/run.md`. To render a saved result again:

```bash
node dist/cli.js leaderboard benchmark-results/run.json
```

## Configuration

See [`examples/benchmark.config.json`](examples/benchmark.config.json). The config is intentionally plain JSON so it works without a YAML parser or provider SDK.

```json
{
  "version": 1,
  "repository": "examples/tasks/string-utils",
  "agents": [
    {
      "id": "codex",
      "name": "Codex",
      "command": "codex",
      "args": ["exec", "--json", "--full-auto", "{prompt}"],
      "env": { "OPENAI_API_KEY": "{env:OPENAI_API_KEY}" },
      "inheritEnv": false,
      "tokenParser": "codex-jsonl"
    },
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "claude",
      "args": ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "{prompt}"],
      "env": { "ANTHROPIC_API_KEY": "{env:ANTHROPIC_API_KEY}" },
      "inheritEnv": false,
      "tokenParser": "claude-json"
    }
  ],
  "tasks": [
    {
      "id": "unicode-reverse",
      "prompt": "Implement reverseText so it reverses Unicode grapheme clusters. Keep the current API.",
      "checks": [
        { "name": "acceptance", "run": "node \"{benchmark}/examples/tasks/string-utils/check.mjs\" \"{workspace}\"" }
      ]
    }
  ]
}
```

`{prompt}` is replaced in agent arguments and environment values. If no argument includes `{prompt}`, the prompt is sent on standard input. `{workspace}` expands to the temporary task copy. In a check command it also gives the checker the candidate workspace path. `{benchmark}` expands to the directory containing the config file, so a check script can live outside the writable task copy. `{env:NAME}` copies a named variable from the current process into an agent's configured environment. Each check runs through the system shell from `workdir` (or the repository root) after the agent exits.

Task and check weights must be positive numbers and default to `1`. Agent timeouts default to 900 seconds; check timeouts default to 60 seconds. `tokenParser` accepts `codex-jsonl`, `claude-json`, or `none`. The built-in parsers read Codex JSONL token usage and completed turns, or Claude Code JSON usage and `num_turns`. Other CLIs can still be timed, but turn and token counts will be `n/a`.

Agent commands inherit the current process environment by default. Set `inheritEnv` to `false` to pass only basic runtime variables and the variables listed in that agent's `env` map. Check commands run with the reduced environment and do not receive provider API keys through `process.env`. Keep acceptance-check scripts outside the task repository and use `{benchmark}` and `{workspace}` so the agent cannot change the checker in its writable copy.

### Add another agent

Use any installed command line agent, including a wrapper script. Arguments are an array, not a shell string:

```json
{
  "id": "my-agent",
  "command": "my-agent",
  "args": ["--prompt", "{prompt}", "--cwd", "{workspace}"],
  "timeoutSeconds": 600
}
```

This is the adapter interface for Cursor, Copilot, local models, or a private agent; there are no built-in integrations for those tools yet. CLI flags change over time, so use the command documented by the installed version of your tool.

## How scoring works

The headline score reflects task completion and acceptance checks. It does not grade code style or maintainability:

```text
70% × weighted task pass rate + 30% × weighted acceptance-check pass rate
```

A task passes when the agent exits successfully and all of its checks pass. Check output, duration, errors, and per-task results are included in JSON. Reported time includes workspace setup, the agent run, and its checks. Agent turns and token totals are shown separately and do not change the score. They are `n/a` unless the selected parser can read them from the CLI output. Cost is not estimated because provider prices and billing details vary.

For a meaningful comparison, publish the task source, exact prompts, checks, agent CLI versions, model names, limits, and run environment. Repeat runs to account for model and infrastructure variability. Avoid comparing scores from different benchmark suites.

## GitHub Actions

The repository includes a composite action and a [manual example workflow](.github/workflows/benchmark.yml). The action builds the CLI, runs your config, and writes JSON and Markdown reports into the caller's workspace. Agent CLIs must already be installed in the workflow. For API-key authentication, pass keys using the action's dedicated inputs and reference them in the relevant agent's `env` map as shown above.

To use it from another repository, add a step after checkout and agent setup:

```yaml
- uses: actions/checkout@v6
- uses: actions/setup-node@v7
  with:
    node-version: 24
- run: npm install --global @openai/codex@0.162.1 @anthropic-ai/claude-code@2.1.296
- uses: setmp-23/agent-bench@v0.1.0
  with:
    config: benchmark.config.json
    output: benchmark-results/run.json
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    # Optional score gate:
    # fail-under: 80
- uses: actions/upload-artifact@v5
  if: always()
  with:
    name: agent-bench-results
    path: benchmark-results/
    if-no-files-found: ignore
```

Pin a release tag or commit when you adopt it. The optional `fail-under` input makes the action fail when no agent reaches the given score; the report is still written first.

The example workflow pins the CLI package versions used for its sample run. Update those versions deliberately when you want to compare newer releases.

**Only run the benchmark on repositories and tasks you trust.** Agents and acceptance checks execute code. That code can read environment variables, including provider keys, and may have network access. Use dedicated keys with low limits. The supplied benchmark workflow is manual and does not run agent code for pull requests.

## Isolation and limits

- Tasks run in a temporary copy that omits `.git`, dependency/build caches, common credential directories, environment files other than `.env.example`, and common private-key files. agent-bench initializes a clean Git snapshot in that copy; each task and agent gets a fresh copy.
- File symlinks are copied only when they point to regular files inside the repository. Symlinks outside the repository, into excluded folders, or to directories/special files are rejected.
- This is workspace isolation, **not a security sandbox**. Agents can execute arbitrary commands and may use network access or inherited credentials. Use a disposable VM/container without secrets for untrusted tasks.
- The task repository is copied from its current on-disk state. Keep it unchanged during a run and make the benchmark base revision explicit in your own workflow.
- Checks are shell commands from your config and run with the task workspace as their working directory.
- This MVP runs agents and tasks sequentially. It does not calculate statistical confidence intervals.
- Agent commands inherit the environment by default. Use `inheritEnv: false` and explicit `env` mappings for API keys when practical. Checks receive a reduced environment, but workspace isolation is not a security boundary: commands can still read files available to the runner user or use network access.
- The `init` command creates a starter config with `npm run check`; replace that check with one that fits the project. For benchmark suites intended to resist check tampering, keep the checker outside the task repository and reference it with `{benchmark}`.

## Contributing

Contributions should make results more reproducible and harder to game. Please include the task, expected outcome, and the exact acceptance checks for new benchmark suites. Do not submit credentials or private repository contents.

## License

MIT. See [LICENSE](LICENSE).
