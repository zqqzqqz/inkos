import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlayStore } from "../play/play-store.js";

describe("PlayStore", () => {
  it("creates world/run storage and persists JSONL events", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-play-store-"));
    const store = new PlayStore(root);

    try {
      await store.ensureWorld("rain-teahouse");
      await store.ensureRun("rain-teahouse", "run-001");

      await store.appendEvent("rain-teahouse", "run-001", {
        id: "event-0001",
        turn: 1,
        actionKind: "look",
        rawInput: "看看车机屏幕",
        outcomeSummary: "宋词看见常用地址统计。",
        createdAt: "2026-05-28T00:00:00.000Z",
      });

      await store.appendEvent("rain-teahouse", "run-001", {
        id: "event-0002",
        turn: 2,
        actionKind: "say",
        rawInput: "问他刚才删了什么",
        outcomeSummary: "徐晋安警觉提高。",
        createdAt: "2026-05-28T00:01:00.000Z",
      });

      const events = await store.readEvents("rain-teahouse", "run-001");
      expect(events.map((event) => event.id)).toEqual(["event-0001", "event-0002"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists transcripts, current state, and markdown projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-play-store-"));
    const store = new PlayStore(root);

    try {
      await store.ensureRun("rain-teahouse", "run-001");

      await store.appendTranscriptTurn("rain-teahouse", "run-001", {
        role: "user",
        content: "看看车机屏幕",
        timestamp: 1779916800000,
      });
      await store.appendTranscriptTurn("rain-teahouse", "run-001", {
        role: "assistant",
        content: "屏幕亮起，常用地址统计停在新城花园。",
        timestamp: 1779916801000,
      });

      await store.saveCurrentState("rain-teahouse", "run-001", {
        turn: 1,
        activeSceneId: "scene-car",
        activeLocation: "车内",
        currentObjective: "确认徐晋安是否隐瞒同居地点",
      });
      await store.writeProjection("rain-teahouse", "run-001", "state/current.md", "# 当前状态\n\n车内。");

      expect(await store.readTranscript("rain-teahouse", "run-001")).toHaveLength(2);
      expect(await store.loadCurrentState("rain-teahouse", "run-001")).toMatchObject({
        activeSceneId: "scene-car",
      });
      await expect(store.readProjection("rain-teahouse", "run-001", "state/current.md"))
        .resolves.toContain("车内");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores malformed JSONL rows when reading logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-play-store-"));
    const store = new PlayStore(root);

    try {
      await store.ensureRun("rain-teahouse", "run-001");
      await store.appendRawEventLine("rain-teahouse", "run-001", "{bad json");
      await store.appendEvent("rain-teahouse", "run-001", {
        id: "event-0001",
        turn: 1,
        actionKind: "wait",
        rawInput: "先不说话",
        outcomeSummary: "对方先开口。",
        createdAt: "2026-05-28T00:00:00.000Z",
      });

      const events = await store.readEvents("rain-teahouse", "run-001");
      expect(events).toHaveLength(1);
      expect(events[0]?.actionKind).toBe("wait");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
