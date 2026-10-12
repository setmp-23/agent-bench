export type Check = { name: string; run: string; weight?: number; timeoutSeconds?: number };
export type Task = {
  id: string;
  prompt: string;
  weight?: number;
  checks: Check[];
};
export type Agent = {
  id: string;
  name?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutSeconds?: number;
  tokenParser?: "codex-jsonl" | "claude-json" | "none";
};
export type Config = {
  version: 1;
  repository?: string;
  workdir?: string;
  agents: Agent[];
  tasks: Task[];
};

export type CheckResult = { name: string; passed: boolean; durationMs: number; output: string };
export type TaskResult = {
  taskId: string;
  passed: boolean;
  checks: CheckResult[];
  durationMs: number;
  tokens: number | null;
  iterations: number | null;
  error?: string;
};
export type AgentResult = {
  agentId: string;
  name: string;
  score: number;
  successRate: number;
  checkRate: number;
  durationMs: number;
  tokens: number | null;
  iterations: number | null;
  tasks: TaskResult[];
};
export type Report = { schemaVersion: 1; startedAt: string; finishedAt: string; results: AgentResult[] };
