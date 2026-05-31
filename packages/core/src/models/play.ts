import { z } from "zod";

export const PlayActionKindSchema = z.enum(["look", "say", "move", "do", "wait"]);
export type PlayActionKind = z.infer<typeof PlayActionKindSchema>;

export const PlayActionIntentSchema = z.object({
  actionKind: PlayActionKindSchema,
  // Interpreters often emit null (not just an absent field) when an action has no
  // entity/location target. Accept null/empty and normalize to undefined so a valid
  // no-target action (look/say/wait) does not crash play_step on a Zod type error.
  targetEntityLabel: z.string().nullish().transform((v) => (v && v.trim() ? v : undefined)),
  targetLocationLabel: z.string().nullish().transform((v) => (v && v.trim() ? v : undefined)),
  intent: z.string().default(""),
  manner: z.string().default(""),
  risk: z.string().default(""),
  ambiguity: z.string().default(""),
  secondaryActions: z.array(z.string().min(1)).default([]),
});
export type PlayActionIntentInput = z.input<typeof PlayActionIntentSchema>;
export type PlayActionIntent = z.infer<typeof PlayActionIntentSchema>;

export const PlayEntityTypeSchema = z.enum([
  "actor",
  "location",
  "item",
  "evidence",
  "clue",
  "claim",
  "proof_chain",
  "organization",
  "rule",
  "scene",
  "event",
]);
export type PlayEntityType = z.infer<typeof PlayEntityTypeSchema>;

export const PlayEntitySchema = z.object({
  id: z.string().min(1),
  type: PlayEntityTypeSchema,
  label: z.string().min(1),
  summary: z.string().default(""),
  status: z.string().default(""),
  createdEventId: z.string().min(1).optional(),
  updatedEventId: z.string().min(1).optional(),
});
export type PlayEntityInput = z.input<typeof PlayEntitySchema>;
export type PlayEntity = z.infer<typeof PlayEntitySchema>;

export const PlayVisibilitySchema = z.record(z.string(), z.string());
export type PlayVisibility = z.infer<typeof PlayVisibilitySchema>;

export const PlayEdgeSchema = z.object({
  id: z.string().min(1),
  fromId: z.string().min(1),
  type: z.string().min(1),
  toId: z.string().min(1),
  value: z.record(z.string(), z.unknown()).default({}),
  validFromEventId: z.string().min(1),
  validUntilEventId: z.string().min(1).nullable().default(null),
  sourceEventId: z.string().min(1),
  visibility: PlayVisibilitySchema.default({}),
  strength: z.number().finite().optional(),
  confidence: z.number().finite().optional(),
});
export type PlayEdgeInput = z.input<typeof PlayEdgeSchema>;
export type PlayEdge = z.infer<typeof PlayEdgeSchema>;

export const PlayStateSlotKindSchema = z.enum([
  "resource",
  "relation",
  "pressure",
  "clue",
  "evidence",
  "flag",
  "timer",
]);
export type PlayStateSlotKind = z.infer<typeof PlayStateSlotKindSchema>;

export const PlayStateSlotSchema = z.object({
  id: z.string().min(1),
  ownerEntityId: z.string().min(1).nullable().optional(),
  kind: PlayStateSlotKindSchema,
  label: z.string().min(1),
  value: z.unknown(),
  updatedEventId: z.string().min(1),
});
export type PlayStateSlotInput = z.input<typeof PlayStateSlotSchema>;
export type PlayStateSlot = z.infer<typeof PlayStateSlotSchema>;

export const PlayEvidenceStatusSchema = z.enum([
  "unknown",
  "hinted",
  "seen",
  "collected",
  "verified",
  "weaponized",
  "exposed",
  "exhausted",
]);
export type PlayEvidenceStatus = z.infer<typeof PlayEvidenceStatusSchema>;

export const PlayEvidenceTransitionSchema = z.object({
  entityId: z.string().min(1),
  from: PlayEvidenceStatusSchema.optional(),
  to: PlayEvidenceStatusSchema,
  reason: z.string().default(""),
});
export type PlayEvidenceTransitionInput = z.input<typeof PlayEvidenceTransitionSchema>;
export type PlayEvidenceTransition = z.infer<typeof PlayEvidenceTransitionSchema>;

export const PlayEventSchema = z.object({
  id: z.string().min(1),
  turn: z.number().int().min(0),
  actionKind: PlayActionKindSchema,
  rawInput: z.string().min(1),
  outcomeSummary: z.string().default(""),
  createdAt: z.string().min(1),
});
export type PlayEventInput = z.input<typeof PlayEventSchema>;
export type PlayEvent = z.infer<typeof PlayEventSchema>;

export const PlayMutationSchema = z.object({
  eventId: z.string().min(1),
  turn: z.number().int().min(0),
  actionKind: PlayActionKindSchema,
  summary: z.string().default(""),
  entities: z.object({
    upsert: z.array(PlayEntitySchema).default([]),
  }).default({ upsert: [] }),
  edges: z.object({
    upsert: z.array(PlayEdgeSchema).default([]),
    expire: z.array(z.object({
      edgeId: z.string().min(1),
      validUntilEventId: z.string().min(1),
      reason: z.string().default(""),
    })).default([]),
  }).default({ upsert: [], expire: [] }),
  stateSlots: z.object({
    upsert: z.array(PlayStateSlotSchema).default([]),
  }).default({ upsert: [] }),
  evidence: z.object({
    transitions: z.array(PlayEvidenceTransitionSchema).default([]),
  }).default({ transitions: [] }),
  blocked: z.boolean().default(false),
  blockedReason: z.string().default(""),
  notes: z.array(z.string()).default([]),
});
export type PlayMutationInput = z.input<typeof PlayMutationSchema>;
export type PlayMutation = z.infer<typeof PlayMutationSchema>;
