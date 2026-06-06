import { describe, it, expect } from "vitest";
import type { ToolExecution } from "../../../store/chat/types";
import { getGeneratedArtifactDetails, getPlayToolDetails, getProposedActionDetails, groupToolExecutionsChronologically } from "../ToolExecutionSteps";

const makeExec = (overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution => ({
  label: "test",
  status: "completed",
  startedAt: Date.now(),
  ...overrides,
});

describe("groupChronologically", () => {
  it("keeps read before pipeline when read happened first", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
  });

  it("groups consecutive utility tools together", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "grep", label: "搜索" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("utilities");
    if (groups[0].type === "utilities") {
      expect(groups[0].execs).toHaveLength(3);
    }
  });

  it("interleaves utility groups around pipeline ops", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
    expect(groups[2].type).toBe("utilities");
    if (groups[2].type === "utilities") {
      expect(groups[2].execs).toHaveLength(2);
    }
  });

  it("handles pipeline-only executions", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("pipeline");
  });

  it("handles empty array", () => {
    expect(groupToolExecutionsChronologically([])).toHaveLength(0);
  });

  it("renders short fiction and cover tools as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "generate_cover", label: "生成封面" }),
      makeExec({ id: "3", tool: "short_fiction_run", label: "短篇生产" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("generate_cover");
    expect(groups[2].type === "pipeline" ? groups[2].exec.tool : "").toBe("short_fiction_run");
  });

  it("renders play tools as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "play_start", label: "启动互动世界" }),
      makeExec({ id: "3", tool: "play_step", label: "推进互动世界" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("play_start");
    expect(groups[2].type === "pipeline" ? groups[2].exec.tool : "").toBe("play_step");
  });

  it("renders proposed actions as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "propose_action", label: "确认动作" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("propose_action");
  });

  it("renders context compression as a visible pipeline card", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "context_compression", label: "整理会话记忆" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("context_compression");
  });

  it("extracts generated cover details from public short fiction tools", () => {
    const exec = makeExec({
      id: "short-1",
      tool: "short_fiction_run",
      label: "短篇生产",
      details: {
        kind: "short_fiction_created",
        storyId: "demo-story",
        finalMarkdownPath: "shorts/demo-story/final/full.md",
        salesPackagePath: "shorts/demo-story/final/sales-package.md",
        coverImagePath: "shorts/demo-story/final/cover.png",
      },
    });

    expect(getGeneratedArtifactDetails(exec)).toMatchObject({
      kind: "short_fiction_created",
      storyId: "demo-story",
      finalMarkdownPath: "shorts/demo-story/final/full.md",
      salesPackagePath: "shorts/demo-story/final/sales-package.md",
      coverImagePath: "shorts/demo-story/final/cover.png",
    });
  });

  it("extracts play scene details from play tools", () => {
    const exec = makeExec({
      id: "play-1",
      tool: "play_step",
      label: "推进互动世界",
      details: {
        kind: "play_turn_advanced",
        title: "雨夜茶馆",
        worldId: "rain-teahouse",
        runId: "main",
        sceneText: "你翻开账本，发现一张旧船票。",
        suggestedActions: ["藏起船票", "追问来人"],
      },
    });

    expect(getPlayToolDetails(exec)).toMatchObject({
      kind: "play_turn_advanced",
      title: "雨夜茶馆",
      worldId: "rain-teahouse",
      runId: "main",
      sceneText: "你翻开账本，发现一张旧船票。",
      suggestedActions: ["藏起船票", "追问来人"],
    });
  });

  it("extracts proposed action details", () => {
    const exec = makeExec({
      id: "proposal-1",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "short_run",
        targetSessionKind: "short",
        sameSession: true,
        title: "生成短篇",
        summary: "确认后生成完整短篇。",
        instruction: "写一篇婚姻反杀短篇",
        actionPayload: {
          shortRun: {
            direction: "婚姻反杀",
            chapters: 12,
            charsPerChapter: 1000,
            cover: true,
          },
        },
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      kind: "proposed_action",
      execId: "proposal-1",
      action: "short_run",
      targetSessionKind: "short",
      sameSession: true,
      title: "生成短篇",
      instruction: "写一篇婚姻反杀短篇",
      actionPayload: {
        shortRun: {
          direction: "婚姻反杀",
          chapters: 12,
          charsPerChapter: 1000,
          cover: true,
        },
      },
    });
  });

  it("extracts proposed route actions for existing Studio workflows", () => {
    const cases = [
      { action: "fanfic_init", route: "import:fanfic", title: "打开同人创作" },
      { action: "spinoff_create", route: "import:spinoff", title: "打开番外创作" },
      { action: "style_imitation", route: "import:imitation", title: "打开仿写创作" },
    ] as const;

    for (const item of cases) {
      const exec = makeExec({
        id: `proposal-route-${item.action}`,
        tool: "propose_action",
        label: "确认动作",
        details: {
          kind: "proposed_action",
          action: item.action,
          targetSessionKind: "chat",
          targetRoute: item.route,
          title: item.title,
          summary: "确认后打开对应工具入口。",
          instruction: "打开对应工具，等待用户补充材料。",
        },
      });

      expect(getProposedActionDetails(exec)).toMatchObject({
        kind: "proposed_action",
        execId: `proposal-route-${item.action}`,
        action: item.action,
        targetSessionKind: "chat",
        targetRoute: item.route,
        title: item.title,
        instruction: "打开对应工具，等待用户补充材料。",
      });
    }
  });

  it("ignores invalid proposed target routes", () => {
    const exec = makeExec({
      id: "proposal-bad-route",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "fanfic_init",
        targetSessionKind: "chat",
        targetRoute: "https://example.com",
        instruction: "打开同人工具。",
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      action: "fanfic_init",
      targetRoute: undefined,
    });
  });
});
