import type { StateCreator } from "zustand";
import type { ChatStore, MessageActions, MessagePart, PipelineStage, ToolExecution } from "../../types";
import { shouldRefreshSidebarForTool } from "../../message-policy";
import {
  deriveFlat,
  extractToolDetails,
  extractToolError,
  findRunningToolPart,
  getOrCreateStream,
  replaceLast,
  resolveToolLabel,
  sessionMatchesEvent,
  summarizeResult,
  updateSession,
} from "./runtime";

type SliceSet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[0];
type SliceGet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[1];

type ContextCompressionCategory = "session_context" | "story_context";
type ContextCompressionPhase = "start" | "end" | "error";

interface ContextCompressionEventPayload {
  readonly sessionId?: string;
  readonly category?: ContextCompressionCategory;
  readonly phase?: ContextCompressionPhase;
  readonly message?: string;
  readonly protectedTokens?: number;
  readonly compressibleTokens?: number;
  readonly budgetTokens?: number;
  readonly sources?: readonly string[];
}

interface AttachSessionStreamListenersInput {
  sessionId: string;
  streamTs: number;
  streamEs: EventSource;
  set: SliceSet;
  get: SliceGet;
}

export function attachSessionStreamListeners({
  sessionId,
  streamTs,
  streamEs,
  set,
  get,
}: AttachSessionStreamListenersInput): void {
  streamEs.addEventListener("thinking:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? []), { type: "thinking" as const, content: "", streaming: true }];
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          const last = parts[parts.length - 1];
          if (last?.type === "thinking") {
            parts[parts.length - 1] = { ...last, content: last.content + data.text };
          }
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          const last = parts[parts.length - 1];
          if (last?.type === "thinking") {
            parts[parts.length - 1] = { ...last, streaming: false };
          }
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("draft:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.text) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          const last = parts[parts.length - 1];
          if (last?.type === "text") {
            parts[parts.length - 1] = { ...last, content: last.content + data.text };
          } else {
            parts.push({ type: "text", content: data.text });
          }
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.tool) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];

          if (data.tool === "sub_agent") {
            const last = parts[parts.length - 1];
            if (last?.type === "text" && last.content) {
              parts.pop();
              const prev = parts[parts.length - 1];
              if (prev?.type === "thinking") {
                parts[parts.length - 1] = {
                  ...prev,
                  content: prev.content + (prev.content ? "\n\n" : "") + last.content,
                };
              } else {
                parts.push({ type: "thinking", content: last.content, streaming: false });
              }
            }
          }

          const agent = data.tool === "sub_agent" ? (data.args?.agent as string | undefined) : undefined;
          const stages: PipelineStage[] | undefined = Array.isArray(data.stages) && data.stages.length > 0
            ? (data.stages as string[]).map((label) => ({ label, status: "pending" as const }))
            : undefined;

          parts.push({
            type: "tool",
            execution: {
              id: data.id as string,
              tool: data.tool as string,
              agent,
              label: resolveToolLabel(data.tool as string, agent),
              status: "running",
              args: data.args as Record<string, unknown> | undefined,
              stages,
              startedAt: Date.now(),
            },
          });

          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.tool) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== data.id) return part;
            const execution = { ...part.execution };
            execution.status = data.isError ? "error" : "completed";
            execution.completedAt = Date.now();
            execution.stages = execution.stages?.map((stage) =>
              stage.status !== "completed"
                ? { ...stage, status: "completed" as const, progress: undefined }
                : stage,
            );
            if (data.isError) execution.error = extractToolError(data.result);
            else execution.result = summarizeResult(data.result);
            const details = data.details ?? extractToolDetails(data.result);
            if (details !== undefined) execution.details = details;
            return { type: "tool" as const, execution };
          });
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));

      if (shouldRefreshSidebarForTool(data.tool as string)) {
        get().bumpBookDataVersion();
      }
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("log", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      const message = data?.message as string | undefined;
      if (!message) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          if (!runningTool) return {};
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
            return {
              type: "tool" as const,
              execution: { ...part.execution, logs: [...(part.execution.logs ?? []), message] },
            };
          });
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("llm:progress", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          if (!runningTool?.execution.stages) return {};
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                stages: part.execution.stages?.map((stage) =>
                  stage.status === "active"
                    ? {
                        ...stage,
                        progress: {
                          status: data.status,
                          elapsedMs: data.elapsedMs,
                          totalChars: data.totalChars,
                          chineseChars: data.chineseChars,
                        },
                      }
                    : stage,
                ),
              },
            };
          });
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("context:compression", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) as ContextCompressionEventPayload : null;
      if (!sessionMatchesEvent(sessionId, data) || !data?.category || !data.phase) return;
      const category = data.category;
      const phase = data.phase;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          applyContextCompressionToParts(parts, category, phase, data);
          const flat = deriveFlat(parts);
          return { messages: replaceLast(messages, { ...stream, ...flat, parts }) };
        }),
      }));
    } catch {
      // ignore
    }
  });
}

function compressionLabel(category: ContextCompressionCategory): string {
  return category === "session_context" ? "整理会话记忆" : "压缩故事上下文";
}

function compressionProgress(data: ContextCompressionEventPayload): PipelineStage["progress"] | undefined {
  if (data.phase !== "start") return undefined;
  const parts = [
    data.protectedTokens !== undefined ? `保护 ${data.protectedTokens}` : "",
    data.compressibleTokens !== undefined ? `可压缩 ${data.compressibleTokens}` : "",
    data.budgetTokens !== undefined ? `预算 ${data.budgetTokens}` : "",
  ].filter(Boolean);
  return {
    status: parts.length > 0 ? parts.join(" · ") : "compressing",
    elapsedMs: 0,
    totalChars: 0,
    chineseChars: 0,
  };
}

function upsertCompressionStage(
  stages: PipelineStage[] | undefined,
  category: ContextCompressionCategory,
  phase: ContextCompressionPhase,
  data: ContextCompressionEventPayload,
): PipelineStage[] {
  const label = compressionLabel(category);
  const found = stages?.some((stage) => stage.label === label) ?? false;
  const base = found ? [...(stages ?? [])] : [...(stages ?? []), { label, status: "pending" as const }];
  const status: PipelineStage["status"] = phase === "start" ? "active" : "completed";
  return base.map((stage) =>
    stage.label === label
      ? { ...stage, status, progress: phase === "start" ? compressionProgress(data) : undefined }
      : stage
  );
}

function findRunningExecution(parts: MessagePart[]): ToolExecution | undefined {
  const running = findRunningToolPart(parts);
  return running?.execution;
}

function applyContextCompressionToParts(
  parts: MessagePart[],
  category: ContextCompressionCategory,
  phase: ContextCompressionPhase,
  data: ContextCompressionEventPayload,
): void {
  const running = category === "session_context" ? undefined : findRunningExecution(parts);
  if (running) {
    running.stages = upsertCompressionStage(running.stages, category, phase, data);
    if (phase === "error") {
      running.status = "error";
      running.error = data.message ?? `${compressionLabel(category)}失败`;
    }
    return;
  }

  const id = `context-${category}`;
  const existing = parts.find((part): part is { type: "tool"; execution: ToolExecution } =>
    part.type === "tool" && part.execution.id === id
  );
  const status: ToolExecution["status"] = phase === "start" ? "running" : phase === "error" ? "error" : "completed";
  const execution = existing?.execution ?? {
    id,
    tool: "context_compression",
    label: compressionLabel(category),
    status,
    stages: [],
    startedAt: Date.now(),
  };
  execution.status = status;
  execution.label = compressionLabel(category);
  execution.stages = upsertCompressionStage(execution.stages, category, phase, data);
  if (phase !== "start") execution.completedAt = Date.now();
  if (phase === "error") execution.error = data.message ?? `${compressionLabel(category)}失败`;
  if (!existing) parts.push({ type: "tool", execution });
}
