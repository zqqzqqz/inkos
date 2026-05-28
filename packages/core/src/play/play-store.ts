import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { z } from "zod";
import { PlayEventSchema, type PlayEvent } from "../models/play.js";

const WORLDS_DIR = "worlds";

const PlayTranscriptTurnSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export type PlayTranscriptTurn = z.infer<typeof PlayTranscriptTurnSchema>;

export class PlayStore {
  constructor(private readonly projectRoot: string) {}

  worldDir(worldId: string): string {
    return join(this.projectRoot, WORLDS_DIR, assertSafeSegment(worldId));
  }

  runDir(worldId: string, runId: string): string {
    return join(this.worldDir(worldId), "runs", assertSafeSegment(runId));
  }

  async ensureWorld(worldId: string): Promise<void> {
    await mkdir(this.worldDir(worldId), { recursive: true });
  }

  async ensureRun(worldId: string, runId: string): Promise<void> {
    const dir = this.runDir(worldId, runId);
    await Promise.all([
      mkdir(dir, { recursive: true }),
      mkdir(join(dir, "state"), { recursive: true }),
      mkdir(join(dir, "projections"), { recursive: true }),
      mkdir(join(dir, "summaries"), { recursive: true }),
      mkdir(join(dir, "checkpoints"), { recursive: true }),
    ]);
  }

  async appendEvent(worldId: string, runId: string, event: PlayEvent): Promise<void> {
    await this.ensureRun(worldId, runId);
    await this.appendJsonLine(
      this.eventsPath(worldId, runId),
      PlayEventSchema.parse(event),
    );
  }

  async appendRawEventLine(worldId: string, runId: string, line: string): Promise<void> {
    await this.ensureRun(worldId, runId);
    await appendFile(this.eventsPath(worldId, runId), `${line}\n`, "utf-8");
  }

  async readEvents(worldId: string, runId: string): Promise<PlayEvent[]> {
    return this.readJsonLines(this.eventsPath(worldId, runId), PlayEventSchema);
  }

  async appendTranscriptTurn(
    worldId: string,
    runId: string,
    turn: PlayTranscriptTurn,
  ): Promise<void> {
    await this.ensureRun(worldId, runId);
    await this.appendJsonLine(
      this.transcriptPath(worldId, runId),
      PlayTranscriptTurnSchema.parse(turn),
    );
  }

  async readTranscript(worldId: string, runId: string): Promise<PlayTranscriptTurn[]> {
    return this.readJsonLines(this.transcriptPath(worldId, runId), PlayTranscriptTurnSchema);
  }

  async saveCurrentState(
    worldId: string,
    runId: string,
    state: unknown,
  ): Promise<void> {
    await this.ensureRun(worldId, runId);
    await writeFile(
      join(this.runDir(worldId, runId), "state", "current.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf-8",
    );
  }

  async loadCurrentState(worldId: string, runId: string): Promise<unknown> {
    const raw = await readFile(join(this.runDir(worldId, runId), "state", "current.json"), "utf-8");
    return JSON.parse(raw) as unknown;
  }

  async writeProjection(
    worldId: string,
    runId: string,
    relativePath: string,
    content: string,
  ): Promise<void> {
    await this.ensureRun(worldId, runId);
    const target = this.safeRunChildPath(worldId, runId, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf-8");
  }

  async readProjection(worldId: string, runId: string, relativePath: string): Promise<string> {
    return readFile(this.safeRunChildPath(worldId, runId, relativePath), "utf-8");
  }

  private eventsPath(worldId: string, runId: string): string {
    return join(this.runDir(worldId, runId), "events.jsonl");
  }

  private transcriptPath(worldId: string, runId: string): string {
    return join(this.runDir(worldId, runId), "transcript.jsonl");
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8");
  }

  private async readJsonLines<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }

    const rows: T[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
      } catch {
        // Ignore malformed rows so one interrupted write does not break a run.
      }
    }
    return rows;
  }

  private safeRunChildPath(worldId: string, runId: string, relativePath: string): string {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
      throw new Error(`Unsafe play path: ${relativePath}`);
    }
    const normalized = normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
      throw new Error(`Unsafe play path: ${relativePath}`);
    }
    return join(this.runDir(worldId, runId), normalized);
  }
}

function assertSafeSegment(value: string): string {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("\0") || value === "." || value === "..") {
    throw new Error(`Unsafe play path segment: ${value}`);
  }
  return value;
}
