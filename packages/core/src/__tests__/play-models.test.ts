import { describe, expect, it } from "vitest";
import {
  PlayActionIntentSchema,
  PlayActionKindSchema,
  PlayEdgeSchema,
  PlayEntitySchema,
  PlayEvidenceStatusSchema,
  PlayMutationSchema,
  PlayStateSlotSchema,
} from "../models/play.js";

describe("play models", () => {
  it("accepts only the supported human action primitives", () => {
    expect(PlayActionKindSchema.options).toEqual(["look", "say", "move", "do", "wait"]);
    expect(() => PlayActionKindSchema.parse("choose")).toThrow();
    expect(() => PlayActionKindSchema.parse("use")).toThrow();
  });

  it("accepts core world entities", () => {
    const entity = PlayEntitySchema.parse({
      id: "evidence_car_address_stats",
      type: "evidence",
      label: "车机常用地址统计",
      summary: "显示新城花园出现 187 次。",
      status: "seen",
      createdEventId: "event-0001",
      updatedEventId: "event-0001",
    });

    expect(entity.type).toBe("evidence");
    expect(entity.label).toContain("车机");

    expect(() => PlayEntitySchema.parse({
      id: "bad",
      type: "weapon",
      label: "bad",
    })).toThrow();
  });

  it("requires temporal source fields on edges", () => {
    const edge = PlayEdgeSchema.parse({
      id: "edge-supports-1",
      fromId: "evidence_car_address_stats",
      type: "supports",
      toId: "claim_husband_cohabits",
      validFromEventId: "event-0001",
      sourceEventId: "event-0001",
      visibility: { player: "seen", system: "known" },
      strength: 0.6,
      confidence: 0.8,
    });

    expect(edge.validUntilEventId).toBeNull();
    expect(edge.visibility.player).toBe("seen");

    expect(() => PlayEdgeSchema.parse({
      id: "edge-bad",
      fromId: "a",
      type: "supports",
      toId: "b",
    })).toThrow();
  });

  it("accepts generic state slots without genre-specific hard-coding", () => {
    const slot = PlayStateSlotSchema.parse({
      id: "slot_husband_suspicion",
      kind: "pressure",
      label: "丈夫警觉",
      ownerEntityId: "actor_xu_jinan",
      value: { current: 35, min: 0, max: 100 },
      updatedEventId: "event-0001",
    });

    expect(slot.kind).toBe("pressure");
    expect(slot.value).toMatchObject({ current: 35 });
  });

  it("models clue and evidence lifecycle explicitly", () => {
    expect(PlayEvidenceStatusSchema.options).toEqual([
      "unknown",
      "hinted",
      "seen",
      "collected",
      "verified",
      "weaponized",
      "exposed",
      "exhausted",
    ]);
  });

  it("accepts action intent with one primary action and secondary notes", () => {
    const intent = PlayActionIntentSchema.parse({
      actionKind: "say",
      targetEntityLabel: "徐晋安",
      intent: "逼问他刚才删了什么",
      manner: "试探但带压迫",
      risk: "提高对方警觉",
      secondaryActions: ["look: 盯着手机屏幕"],
    });

    expect(intent.actionKind).toBe("say");
    expect(intent.secondaryActions).toHaveLength(1);
  });

  it("normalizes null/empty target labels to undefined (no-target actions must not crash)", () => {
    const intent = PlayActionIntentSchema.parse({
      actionKind: "look",
      targetEntityLabel: "枪",
      targetLocationLabel: null,
      intent: "查看枪上有没有编号",
    });
    expect(intent.targetLocationLabel).toBeUndefined();
    expect(intent.targetEntityLabel).toBe("枪");

    const empty = PlayActionIntentSchema.parse({ actionKind: "wait", targetEntityLabel: "" });
    expect(empty.targetEntityLabel).toBeUndefined();
  });

  it("accepts a mutation envelope for world changes", () => {
    const mutation = PlayMutationSchema.parse({
      eventId: "event-0002",
      turn: 2,
      actionKind: "look",
      summary: "宋词看见车机地址统计。",
      entities: {
        upsert: [{
          id: "evidence_car_address_stats",
          type: "evidence",
          label: "车机常用地址统计",
          status: "seen",
          updatedEventId: "event-0002",
        }],
      },
      edges: {
        upsert: [{
          id: "edge-evidence-supports-claim",
          fromId: "evidence_car_address_stats",
          type: "supports",
          toId: "claim_husband_cohabits",
          validFromEventId: "event-0002",
          sourceEventId: "event-0002",
          visibility: { player: "seen", husband: "unknown" },
          strength: 0.6,
        }],
      },
      stateSlots: {
        upsert: [{
          id: "slot_husband_suspicion",
          ownerEntityId: "actor_husband",
          kind: "pressure",
          label: "丈夫警觉",
          value: { current: 45, min: 0, max: 100 },
          updatedEventId: "event-0002",
        }],
      },
      evidence: {
        transitions: [{
          entityId: "evidence_car_address_stats",
          from: "unknown",
          to: "seen",
          reason: "玩家看见常用地址统计。",
        }],
      },
      notes: ["look 动作只暴露信息，不强推高潮。"],
    });

    expect(mutation.entities.upsert).toHaveLength(1);
    expect(mutation.evidence.transitions[0]?.to).toBe("seen");
  });
});
