import { z } from "zod";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import {
  PlayActionIntentSchema,
  PlayMutationSchema,
  type PlayActionIntent,
  type PlayActionIntentInput,
  type PlayMutation,
  type PlayMutationInput,
} from "../models/play.js";

export interface PlayActionInterpreterInput {
  readonly input: string;
  readonly sceneBrief: string;
  readonly language?: "zh" | "en";
}

export interface PlayWorldMutatorInput {
  readonly turn: number;
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly context: string;
  readonly language?: "zh" | "en";
}

export interface PlaySceneRenderInput {
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly mutationSummary: string;
  readonly stateBrief: string;
  readonly language?: "zh" | "en";
}

const PlaySceneRenderSchema = z.object({
  sceneText: z.string().min(1),
  suggestedActions: z.array(z.string().min(1)).min(0).max(4).default([]),
});
export type PlaySceneRender = z.infer<typeof PlaySceneRenderSchema>;

export class PlayActionInterpreterAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-action-interpreter";
  }

  async interpret(input: PlayActionInterpreterInput): Promise<PlayActionIntent> {
    const response = await this.chat([
      { role: "system", content: buildActionInterpreterSystemPrompt(input.language ?? "zh") },
      { role: "user", content: buildActionInterpreterUserPrompt(input, input.language ?? "zh") },
    ], { temperature: 0.15, maxTokens: 1024 });
    // Never throw on the model's output: degrade a fully-unparseable response to a generic action
    // (the player's raw text as a "do") rather than crashing the turn.
    let raw: unknown = {};
    try { raw = parseJson(response.content); } catch { /* malformed JSON → degrade below */ }
    const parsed = PlayActionIntentSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : PlayActionIntentSchema.parse({ actionKind: "do", intent: input.input });
  }
}

export class PlayWorldMutatorAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-world-mutator";
  }

  async proposeMutation(input: PlayWorldMutatorInput): Promise<PlayMutation> {
    const response = await this.chat([
      { role: "system", content: buildWorldMutatorSystemPrompt(input.language ?? "zh") },
      { role: "user", content: buildWorldMutatorUserPrompt(input, input.language ?? "zh") },
    ], { temperature: 0.25, maxTokens: 4096 });
    // Never throw on the model's output: an unparseable mutation degrades to a blocked, no-op turn
    // (with a reason) instead of crashing play_step. eventId is always backfilled.
    let raw: unknown = {};
    try { raw = parseJson(response.content); } catch { /* malformed JSON → degrade below */ }
    const parsed = PlayMutationSchema.safeParse(raw);
    const mutation = parsed.success
      ? parsed.data
      : PlayMutationSchema.parse({
          turn: input.turn,
          actionKind: input.action.actionKind,
          blocked: true,
          blockedReason: "模型输出无法解析为有效的状态变更，本回合未推进世界状态。",
        });
    return { ...mutation, eventId: mutation.eventId || `evt-${input.turn}` };
  }
}

export class PlaySceneRendererAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-scene-renderer";
  }

  async render(input: PlaySceneRenderInput & { readonly mode?: "open" | "guided" }): Promise<PlaySceneRender> {
    const response = await this.chat([
      { role: "system", content: buildSceneRendererSystemPrompt(input.mode ?? "open", input.language ?? "zh") },
      { role: "user", content: buildSceneRendererUserPrompt(input, input.language ?? "zh") },
    ], { temperature: 0.45, maxTokens: 2048 });
    return PlaySceneRenderSchema.parse(parseJson(response.content));
  }
}

function buildActionInterpreterSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You are an interactive-fiction action interpreter.",
      "Your job is to normalize one line of the player's natural language into one of five action kinds: look / say / move / do / wait.",
      "Do not add drama for the player, do not advance the plot, do not write scene prose.",
      "look = observe/examine/recall a clue; say = speak/probe/confront; move = move to a location; do = perform an action/use an item/investigate; wait = wait/stall/watch.",
      "Output strict JSON, no explanation.",
    ].join("\n");
  }
  return [
    "你是互动小说动作理解器。",
    "你的任务是把玩家一句自然语言，归一成五类动作之一：look / say / move / do / wait。",
    "不要替玩家加戏，不要直接推进剧情，不要写场景正文。",
    "look=观察/检查/回忆线索；say=说话/试探/质问；move=移动到地点；do=执行动作/使用物品/调查；wait=等待/拖延/旁观。",
    "输出严格 JSON，不要解释。",
  ].join("\n");
}

function buildActionInterpreterUserPrompt(input: PlayActionInterpreterInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Current scene:",
      input.sceneBrief,
      "",
      "Player input:",
      input.input,
      "",
      "Output fields: actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions.",
    ].join("\n");
  }
  return [
    "当前场景：",
    input.sceneBrief,
    "",
    "玩家输入：",
    input.input,
    "",
    "输出字段：actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions。",
  ].join("\n");
}

function buildWorldMutatorSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You are an interactive-fiction world-state drafter.",
      "Based only on the player's action and the current context, propose this turn's possible state changes as a draft.",
      "Do not write final prose; do not commit to the store on the reducer's behalf; do not let key states jump to completion out of nowhere.",
      "This engine is genre-neutral: romance, adventure, wuxia, mystery, slice-of-life all use the same structure. Entity types: actor/location/item/evidence/clue/claim/proof_chain/organization/rule/scene/event — use as needed.",
      "Give every new or important entity a one-line summary (who/what it is and why it matters), not just a status word — the player expands this summary in the side panel.",
      "Tangible things the player discovers or holds (a clue, a document, a weapon, a token, key evidence) MUST be their own entity (item/evidence/clue), never folded into a person's status — only then can they enter the player's holdings and be tracked.",
      "Use entity.status to record state progress for any genre, with status words suited to this world's genre, advancing step by step without skipping (e.g. relationship: stranger -> curious -> attracted -> lover; injury: healthy -> bleeding -> critical; clue: found -> collected -> confirmed).",
      "When a meaningful relationship forms between actors (ally / rival / kin / suspicion …), record it as an edge so the panel can show it.",
      "Numbers (affection, suspense, resources, health, anger, a countdown, etc.) go in stateSlots: scale them by dramatic logic, big swings allowed, but every change must be explainable from this turn's story — no unmotivated jumps.",
      "Early on (the first few turns), seed the state the premise already establishes: a stated deadline -> a timer slot; the central mystery/objective -> its first clue/evidence entity; already-named key characters -> actor entities with a one-line summary. Don't leave the opening world nearly empty.",
      "Restraint: only create entities and meters the story actually makes real — never invent gratuitous stats or items just to fill the panel.",
      "Only use evidence.transitions for the evidence lifecycle when this world is genuinely an investigation/mystery; otherwise leave it empty.",
      "If the player's action is invalid or information is insufficient, set blocked=true and write blockedReason.",
      "Output strict JSON matching PlayMutation: eventId, turn, actionKind, summary, entities, edges, stateSlots, evidence, blocked, blockedReason, notes.",
    ].join("\n");
  }
  return [
    "你是互动小说世界状态草案员。",
    "你只根据玩家动作和当前上下文，提出本回合可能发生的状态变化草案。",
    "不要写最终正文；不要越权替 reducer 落库；不要凭空让关键状态一步到位。",
    "这套引擎是品类中立的：恋情、冒险、武侠、悬疑、日常等都用同一套结构表达。实体类型用 actor/location/item/evidence/clue/claim/proof_chain/organization/rule/scene/event，按需选用。",
    "给每个新出现或重要的实体写一句 summary（他是谁/这是什么、为什么重要），不要只靠 status 一句话——玩家会在侧栏里展开看这条 summary。",
    "玩家发现或获得的「实物」（线索、文件、凶器、信物、关键证据等）必须建成独立实体（item/evidence/clue），不要塞进某个人物的 status——这样它们才能进入玩家的「持有物」并被追踪。",
    "用 entity.status 记录任意品类的状态推进，状态词按这个世界的题材自定，循序渐进、不要跳级（例如关系：陌生→好奇→心动→恋人；伤势：健康→流血→重伤；线索：发现→收集→坐实）。",
    "人物之间一旦形成有意义的关系（盟友/敌对/亲属/怀疑等），用 edges 记录，便于侧栏展示关系。",
    "数值（好感、悬疑、资源、生命、怒气、倒计时等）放进 stateSlots：按戏剧逻辑给量级，允许大起大落，但每次变化都要能从本回合的故事里解释得通，不要无来由地跳。",
    "开局阶段（前几回合），把前提里已经确立的状态先播种出来：明确的期限→timer 数值；核心谜题/目标物→第一条 clue/evidence 实体；已点名的关键人物→actor 实体并配一句 summary。不要让开场世界几乎空着。",
    "克制：只建剧情真正落地的实体和数值，不要为了填满侧栏而硬造属性或物品。",
    "只有当这个世界确实是调查/推理题材时，才用 evidence.transitions 走证据生命周期；其他题材留空即可。",
    "如果玩家动作无效或信息不足，blocked=true 并写 blockedReason。",
    "输出严格 JSON，必须符合 PlayMutation：eventId, turn, actionKind, summary, entities, edges, stateSlots, evidence, blocked, blockedReason, notes。",
  ].join("\n");
}

function buildWorldMutatorUserPrompt(input: PlayWorldMutatorInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      `turn: ${input.turn}`,
      "Player's words:",
      input.input,
      "",
      "Action interpretation:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Current context:",
      input.context,
      "",
      "Requirement: use eventId evt-" + input.turn + "; every new or referenced entity id must be stable, readable, and short.",
    ].join("\n");
  }
  return [
    `turn: ${input.turn}`,
    "玩家原话：",
    input.input,
    "",
    "动作理解：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "当前上下文：",
    input.context,
    "",
    "要求：eventId 使用 evt-" + input.turn + "；所有新增或引用的实体 id 要稳定、可读、短小。",
  ].join("\n");
}

export function buildSceneRendererSystemPrompt(mode: "open" | "guided" = "open", language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    const base = [
      "You are an interactive-fiction scene-response author.",
      "Write the response only from the already-applied state; do not overturn the reducer's results.",
      "The response should read like a playable novel: action, senses, pressure, room to choose; never a system log.",
    ];
    const actionsRule = mode === "guided"
      ? "This is a choice-driven mode: suggestedActions must give 2-4 every turn — it is the player's only way forward; each option is one directly actionable, concrete move."
      : "Give 2-4 suggested actions as short phrases; in open mode they are only hints and do not restrict the player's input.";
    return [...base, actionsRule, "Output strict JSON: sceneText, suggestedActions."].join("\n");
  }
  const base = [
    "你是互动小说场景回应作者。",
    "你只能根据已经应用后的状态写回应，不要推翻 reducer 结果。",
    "回应要像可玩的小说：有动作、感官、压迫、选择余地；不要写成系统日志。",
  ];
  const actionsRule = mode === "guided"
    ? "这是选项式玩法：suggestedActions 必须给 2-4 个，每回合都要给，是玩家唯一的前进方式；每个选项是一句可直接执行的具体行动。"
    : "建议动作给 2-4 个，短句即可；开放模式下建议动作只是参考，不限制玩家输入。";
  return [...base, actionsRule, "输出严格 JSON：sceneText, suggestedActions。"].join("\n");
}

function buildSceneRendererUserPrompt(input: PlaySceneRenderInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Player's words:",
      input.input,
      "",
      "Action:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Applied changes this turn:",
      input.mutationSummary,
      "",
      "Current state summary:",
      input.stateBrief,
    ].join("\n");
  }
  return [
    "玩家原话：",
    input.input,
    "",
    "动作：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "已应用的本回合变化：",
    input.mutationSummary,
    "",
    "当前状态摘要：",
    input.stateBrief,
  ].join("\n");
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Play agent did not return JSON.");
  }
}
