import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewLayoutBook } from "../utils/outline-paths.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";

/** Files read in this order; anything else in story/ comes after, sorted alphabetically. */
const PRIORITY_FILES = [
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_focus.md",
];

const FULL_INLINE_CHAR_LIMIT = 6000;
const MAX_COMPACT_LINES_PER_FILE = 80;
const MAX_COMPACT_LINE_CHARS = 500;

const CONTEXT_SIGNAL_RE =
  /(active|open|pending|unresolved|current|core|critical|must|进行|活跃|当前|核心|关键|主线|伏笔|未解决|待处理|必须|目标|冲突|证据|状态|角色|关系)/i;

const UPGRADE_HINT =
  "[提示] 当前这本书的架构稿是旧的条目式格式（story_bible.md / volume_outline.md / character_matrix.md）。" +
  "如果作者有意愿升级成段落式架构稿 + 一人一卡的角色目录（outline/story_frame.md + outline/volume_map.md + roles/），" +
  "可以调用 `sub_agent(architect, { revise: true, bookId, feedback: \"把架构稿从条目式升级成段落式架构稿，并把角色矩阵拆成 roles 目录一人一卡\" })`。" +
  "升级只改架构稿，不动已写的章节。在作者没明确同意前不要主动触发。";

export function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
  options: { readonly onContextCompression?: ContextCompressionCallback } = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (bookId === null) {
    return async (messages) => messages;
  }

  const bookDir = join(projectRoot, "books", bookId);
  const storyDir = join(bookDir, "story");

  return async (messages) => {
    const sections = await readTruthFiles(storyDir);
    if (sections.length === 0) return messages;

    const isNew = await isNewLayoutBook(bookDir);
    const hintBlock = isNew ? "" : `\n\n${UPGRADE_HINT}`;
    const compactedSources = sections
      .filter((section) => section.content.length > FULL_INLINE_CHAR_LIMIT)
      .map((section) => section.name);

    if (compactedSources.length > 0) {
      options.onContextCompression?.({
        category: "session_context",
        phase: "start",
        sources: compactedSources,
      });
    }

    const body =
      "[以下是当前书籍的上下文压缩包，每次对话时自动从磁盘读取生成。请基于这些内容进行创作和判断；需要完整原文时再按文件读取。]" +
      hintBlock + "\n\n" +
      sections.map(renderContextSection).join("\n\n");

    if (compactedSources.length > 0) {
      options.onContextCompression?.({
        category: "session_context",
        phase: "end",
        sources: compactedSources,
      });
    }

    const injected: UserMessage = {
      role: "user",
      content: body,
      timestamp: Date.now(),
    };

    return [injected, ...messages];
  };
}

interface TruthFileSection {
  name: string;
  content: string;
}

function renderContextSection(section: TruthFileSection): string {
  if (section.content.length <= FULL_INLINE_CHAR_LIMIT) {
    return `=== ${section.name} ===\n${section.content}`;
  }

  const compact = compactTruthFile(section.content);
  return [
    `=== ${section.name} ===`,
    `[未全文注入：原文件 ${section.content.length} 字符 / ${compact.totalLines} 行。以下为结构化压缩索引；避免让旧设定原文淹没当前用户指令。]`,
    compact.lines.length > 0
      ? compact.lines.join("\n")
      : "[未检测到可压缩的标题、活跃项或关键信号行；请在需要时按文件读取完整内容。]",
    compact.omittedLines > 0 ? `[未注入行数：${compact.omittedLines}。]` : "",
  ].filter(Boolean).join("\n");
}

function compactTruthFile(content: string): { readonly lines: ReadonlyArray<string>; readonly omittedLines: number; readonly totalLines: number } {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let omittedLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      omittedLines += 1;
      continue;
    }
    if (line.length > MAX_COMPACT_LINE_CHARS) {
      omittedLines += 1;
      continue;
    }
    if (isContextSignalLine(line)) {
      selected.push(line);
      if (selected.length >= MAX_COMPACT_LINES_PER_FILE) {
        omittedLines += lines.length - selected.length - omittedLines;
        break;
      }
      continue;
    }
    omittedLines += 1;
  }

  return { lines: selected, omittedLines, totalLines: lines.length };
}

function isContextSignalLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^#{1,4}\s+\S/.test(trimmed) ||
    /^\|.*\|$/.test(trimmed) && CONTEXT_SIGNAL_RE.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) && CONTEXT_SIGNAL_RE.test(trimmed) ||
    CONTEXT_SIGNAL_RE.test(trimmed) && /^[\w\u4e00-\u9fff].{0,80}[:：]/.test(trimmed);
}

async function readTruthFiles(storyDir: string): Promise<TruthFileSection[]> {
  let entries: string[];
  try {
    entries = await readdir(storyDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const prioritySet = new Set(PRIORITY_FILES);
  const prioritized = PRIORITY_FILES.filter((f) => mdFiles.includes(f));
  const rest = mdFiles.filter((f) => !prioritySet.has(f)).sort();
  const ordered = [...prioritized, ...rest];

  const sections: TruthFileSection[] = [];
  for (const fileName of ordered) {
    try {
      const content = await readFile(join(storyDir, fileName), "utf-8");
      sections.push({ name: fileName, content });
    } catch {
      // skip unreadable files
    }
  }
  return sections;
}
