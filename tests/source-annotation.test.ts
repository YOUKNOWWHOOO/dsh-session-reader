// 测试：user/message 的来源标注——md 标签行（含 `--headers` 顺序）、检索命中行、json 归属对象，
// 以及"非用户来源必须可辨、用户本人不标注、不适用的事件类型不标注"这三条边界。
// 依据：SKILL.md「输出格式（md）」的标签行契约与「JSON 与 JSONL 结构」的 messages/matches 条目；
// 实现：scripts\lib\message-source.ts（唯一真值源）。
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderSearchJson, renderShowJson } from "../scripts/lib/render-json.ts";
import { renderSearchMd } from "../scripts/lib/render-md.ts";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import type { SearchOutcome } from "../scripts/lib/store-types.ts";
import { resetTempDir, writeFixtureHome } from "./fixtures.ts";
import { node, showOptions } from "./render-helpers.ts";
import { contextOf } from "./store-helpers.ts";

const SENDER = "aaaa1111-2222-3333-4444-555566667777";

/** 覆盖全部真实来源种类 + 未知 kind + 缺失 source 的事件集（kind 取值来自本机 307 会话的实测）。 */
const EVENTS: Record<string, unknown>[] = [
  { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
  {
    type: "user/message",
    seq: 1,
    time: 11,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 USER-OWN" }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 2,
    time: 12,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 RELAY" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: SENDER },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 3,
    time: 13,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 SETTLED" }],
      source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: SENDER },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 4,
    time: 14,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 PLUGIN" }],
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 5,
    time: 15,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 UNKNOWN" }],
      source: { kind: "weird-kind" },
    },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 6,
    time: 16,
    data: { role: "user", content: [{ type: "text", text: "正文 NOSOURCE" }] },
    surfaceOp: "append",
  },
  {
    type: "user/message",
    seq: 7,
    time: 17,
    data: {
      role: "user",
      content: [{ type: "text", text: "正文 HOSTILE" }],
      // 敌意来源文本：反引号与内嵌换行都会破坏裸写的标签行，必须被行内载体吸收。
      source: { kind: "plugin", plugin: "bad`\nname" },
    },
    surfaceOp: "append",
  },
  {
    type: "assistant/message",
    seq: 8,
    time: 18,
    data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "回复" }] } },
    surfaceOp: "append",
  },
  {
    type: "system/message",
    seq: 9,
    time: 19,
    data: {
      message: {
        role: "system",
        source: { kind: "plugin", plugin: "sys-plugin" },
        content: [{ type: "text", text: "系统 SYSTEM" }],
      },
    },
    surfaceOp: "append",
  },
  { type: "turn/end", seq: 10, time: 20, data: { turn: 1 } },
];

function showMd(overrides: Parameters<typeof showOptions>[0] = {}): string {
  return renderShowMd(node([], EVENTS), showOptions(overrides)).content;
}

describe("md 标签行的来源标注", () => {
  it("用户本人的消息不标注，其它来源逐一标注，未知 kind 入行内载体", () => {
    const content = showMd();
    assert.equal(content.includes("**用户**：\n\n```text\n正文 USER-OWN\n```"), true);
    assert.equal(content.includes(`**用户**（来源 agent-message ${SENDER}）：`), true);
    assert.equal(content.includes(`**用户**（来源 subagent-settled ${SENDER}）：`), true);
    assert.equal(
      content.includes("**用户**（来源 plugin `@deepseek-ai/dsh-system-prompt`）："),
      true,
    );
    assert.equal(content.includes("**用户**（来源 `weird-kind`）："), true);
    assert.equal(content.includes("**用户**（来源 未标注）："), true);
  });

  it("敌意来源文本入行内载体：反引号使跨度加长、内嵌换行被折叠，标签行不被破坏", () => {
    const content = showMd();
    assert.equal(content.includes("**用户**（来源 plugin ``bad` name``）："), true);
    // 标签行必须仍是单行：换行若未被折叠，`来源` 与 `）：` 会落在不同行。
    assert.match(content, /^\*\*用户\*\*（来源 plugin ``bad` name``）：$/mu);
    assert.equal(content.includes("来源 plugin bad"), false);
  });

  it("--headers 时括号内顺序为 seq → 本地时间 → 来源", () => {
    const content = showMd({ headers: true });
    assert.match(
      content,
      new RegExp(`^\\*\\*用户\\*\\*（seq 2；[^；]+；来源 agent-message ${SENDER}）：$`, "mu"),
    );
    assert.match(content, /^\*\*用户\*\*（seq 1；[^；]+）：$/mu);
  });

  it("系统消息与工具结果不适用来源标注", () => {
    const content = showMd({ events: true });
    assert.equal(content.includes("**系统消息**（来源"), false);
    assert.equal(content.includes("**系统消息**：\n\n```text\n系统 SYSTEM\n```"), true);
  });
});

describe("json 归属对象", () => {
  it("show json 的 messages[].source 为对象且字段完整", () => {
    const rendered = renderShowJson(node([], EVENTS), {
      summary: false,
      subagents: false,
      unattributable: [],
    });
    const document = JSON.parse(rendered.content) as {
      messages: { seq: number | null; source: Record<string, unknown> }[];
    };
    const bySeq = new Map(document.messages.map((entry) => [entry.seq, entry.source]));
    assert.deepEqual(bySeq.get(1), {
      kind: "user",
      form: null,
      senderSessionId: null,
      plugin: null,
    });
    assert.deepEqual(bySeq.get(2), {
      kind: "agent-message",
      form: "relay",
      senderSessionId: SENDER,
      plugin: null,
    });
    assert.deepEqual(bySeq.get(4), {
      kind: "plugin",
      form: "snapshot",
      senderSessionId: null,
      plugin: "@deepseek-ai/dsh-system-prompt",
    });
    assert.deepEqual(bySeq.get(6), {
      kind: null,
      form: null,
      senderSessionId: null,
      plugin: null,
    });
  });

  it("search json 的 matches[].source 与条目来源一致，非消息事件为 null", () => {
    const outcome: SearchOutcome = {
      hits: [
        {
          sessionId: "session-aaa-01",
          seq: 2,
          time: 12,
          label: "user",
          excerpt: "RELAY",
          source: { kind: "agent-message", form: "relay", senderSessionId: SENDER, plugin: null },
        },
        {
          sessionId: "session-aaa-01",
          seq: 8,
          time: 18,
          label: "system",
          excerpt: "SYSTEM",
          source: null,
        },
      ],
      totalHits: 2,
      scannedSessions: 1,
      truncated: false,
      searchedSessions: 1,
      scope: "text",
      totalIsExact: true,
      coverage: { scannedCount: 1, includedCount: 1, excluded: [] },
      scan: {
        logsDecoded: 1,
        eventsRead: 10,
        decodeFailures: 0,
        frameFailures: 0,
        observedFrom: 10,
        observedTo: 19,
      },
      distribution: [],
    };
    const document = JSON.parse(renderSearchJson(outcome).content) as {
      matches: { source: unknown }[];
    };
    assert.deepEqual(document.matches[0].source, {
      kind: "agent-message",
      form: "relay",
      senderSessionId: SENDER,
      plugin: null,
    });
    assert.equal(document.matches[1].source, null);
  });
});

describe("检索命中行的来源标注", () => {
  it("md 命中行在 seq 之后追加来源；无归属时不追加", () => {
    const outcome: SearchOutcome = {
      hits: [
        {
          sessionId: "session-aaa-01",
          seq: 2,
          time: 12,
          label: "user",
          excerpt: "命中片段",
          source: {
            kind: "subagent-settled",
            form: "notice",
            senderSessionId: SENDER,
            plugin: null,
          },
        },
        {
          sessionId: "session-aaa-01",
          seq: 8,
          time: 18,
          label: "system",
          excerpt: "无归属片段",
          source: null,
        },
      ],
      totalHits: 2,
      scannedSessions: 1,
      truncated: false,
      searchedSessions: 1,
      scope: "text",
      totalIsExact: true,
      coverage: { scannedCount: 1, includedCount: 1, excluded: [] },
      scan: {
        logsDecoded: 1,
        eventsRead: 10,
        decodeFailures: 0,
        frameFailures: 0,
        observedFrom: 10,
        observedTo: 19,
      },
      distribution: [],
    };
    const content = renderSearchMd(outcome).content;
    assert.equal(
      content.includes(
        `- \`session-aaa-01\`（seq 2；来源 subagent-settled ${SENDER}）\`user\`：\`命中片段\``,
      ),
      true,
    );
    assert.equal(content.includes("- `session-aaa-01`（seq 8）`system`：`无归属片段`"), true);
  });
});

describe("store 层来源挂载", () => {
  it("runSearch 把事件级来源随命中传出，非 user/message 事件为 null", () => {
    const root = join("tests", ".tmp", "source-annotation");
    const home = writeFixtureHome(resetTempDir(root), {
      sessions: [
        {
          id: "session-src-anno-01",
          projectDir: "--C-Users-Alice--",
          createdAt: 1000,
          events: [
            { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
            {
              type: "user/message",
              seq: 1,
              time: 11,
              data: {
                role: "user",
                content: [{ type: "text", text: "needle from relay" }],
                source: { kind: "agent-message", form: "relay", senderSessionId: SENDER },
              },
              surfaceOp: "append",
            },
            {
              type: "user/message",
              seq: 2,
              time: 12,
              data: {
                role: "user",
                content: [{ type: "text", text: "needle from user" }],
                source: { kind: "user" },
              },
              surfaceOp: "append",
            },
            { type: "turn/end", seq: 3, time: 13, data: { turn: 1 } },
          ],
        },
      ],
    });
    const outcome = runSearch(
      contextOf(home),
      "needle",
      { origin: "all" },
      { scope: "text", caseSensitive: false, context: 60, limit: 0 },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const bySeq = new Map(outcome.data.hits.map((hit) => [hit.seq, hit.source]));
    assert.deepEqual(bySeq.get(1), {
      kind: "agent-message",
      form: "relay",
      senderSessionId: SENDER,
      plugin: null,
    });
    assert.deepEqual(bySeq.get(2), {
      kind: "user",
      form: null,
      senderSessionId: null,
      plugin: null,
    });
  });
});
