import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/project-config.ts";

export type LogLevel = "debug" | "info" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, error: 2 };

export class BuildLogger {
  readonly file?: string;
  readonly buildId = randomUUID();
  private readonly started = Date.now();
  private pending = Promise.resolve();
  private readonly minimum: LogLevel;
  private readonly timeline: Array<Record<string, unknown>> = [];
  private status: "running" | "succeeded" | "failed" = "running";
  private finalError?: Record<string, unknown>;
  private summary?: Record<string, unknown>;
  private constructor(file: string | undefined, minimum: LogLevel) { this.file = file; this.minimum = minimum; }

  static async create(config?: ResolvedConfig): Promise<BuildLogger> {
    const file = config?.logging.enabled ? config.logging.file : undefined;
    if (file) await mkdir(dirname(file), { recursive: true });
    return new BuildLogger(file, config?.logging.level ?? "debug");
  }

  record(level: LogLevel, phase: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
    if (!this.file || LEVELS[level] < LEVELS[this.minimum]) return Promise.resolve();
    const entry = { sequence: this.timeline.length + 1, timestamp: new Date().toISOString(), elapsedMs: Date.now() - this.started, level, phase, event, details };
    this.timeline.push(entry);
    if ((phase === "build" || phase === "transpile") && event === "finished") { this.status = "succeeded"; this.summary = details; }
    const snapshot = this.contents();
    this.pending = this.pending.then(() => writeFile(this.file!, snapshot, "utf8"));
    return this.pending;
  }

  error(phase: string, error: unknown): Promise<void> {
    const value = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
    this.status = "failed"; this.finalError = value;
    return this.record("error", phase, "failed", value);
  }

  flush(): Promise<void> { return this.pending; }

  private contents(): string {
    const dependencyEvent = this.timeline.find(entry => entry.phase === "modules" && entry.event === "graph-finished");
    return JSON.stringify({
      schemaVersion: 1,
      build: { id: this.buildId, status: this.status, startedAt: new Date(this.started).toISOString(), updatedAt: new Date().toISOString(), durationMs: Date.now() - this.started },
      dependencyGraph: (dependencyEvent?.details as Record<string, unknown> | undefined) ?? null,
      summary: this.summary ?? null,
      error: this.finalError ?? null,
      timeline: this.timeline
    }, null, 2) + "\n";
  }
}
