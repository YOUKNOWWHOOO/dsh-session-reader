// 验证正式 CLI 对直接工具与 PTC 子调用的呈现、检索和原始记录。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type FixtureEvent, writeFixtureHome } from "./fixtures.ts";

const root = fileURLToPath(new URL("./.tmp/", import.meta.url));
mkdirSync(root, { recursive: true });
const temp = mkdtempSync(join(root, "ptc-cli-"));
const script = fileURLToPath(new URL("../scripts/run-session-reader.ts", import.meta.url));
after(() => rmSync(temp, { recursive: true, force: true }));

type Mode = "standard" | "cordis" | "ptc" | "dsh-custom-ptc";
type Call = { name: string; args: Record<string, unknown>; result: string; error?: boolean };

function fixture(mode: Mode): { home: string; id: string } {
  const id = `session-fixture-${mode}`;
  const home = join(temp, mode, "home");
  const ptc = mode === "ptc" || mode === "dsh-custom-ptc";
  const calls: Call[] = [
    { name: "subagent", args: { description: "fixture", prompt: "TASKMARK" }, result: "started" },
    { name: "send_message", args: { agent_id: "child", message: "MESSAGEMARK" }, result: "sent" },
    { name: "read", args: { file_path: "fixture.txt" }, result: "RESULTMARK" },
  ];
  if (mode !== "dsh-custom-ptc")
    calls.push({
      name: "ask_user_question",
      args: {
        questions: [
          {
            id: "q",
            header: "标题",
            question: "QUESTIONMARK",
            options: [{ label: "one", description: "first" }],
          },
        ],
      },
      result: JSON.stringify({ answers: [{ id: "q", selected: ["one"], custom: "ANSWERMARK" }] }),
    });
  if (mode === "cordis")
    calls.push({ name: "cordis_inspect_list", args: {}, result: "CORDISMARK" });
  if (mode === "dsh-custom-ptc") {
    calls.push({
      name: "mcp_call",
      args: {
        server: "context7",
        tool: "query-docs",
        args: { query: "fixture", libraryId: "/fixture/example" },
      },
      result: "MCPMARK",
    });
    calls.push({
      name: "creation_call",
      args: { tool: "cordis_inspect_list", args: {} },
      result: "CREATIONMARK",
    });
  }
  if (ptc)
    calls.push({
      name: "read_image",
      args: { file_path: "fixture.png" },
      result: "IMAGE TEXT MARK",
    });
  calls.push({ name: "read", args: { file_path: "missing.txt" }, result: "FAILMARK", error: true });
  const events: FixtureEvent[] = [];
  const add = (type: string, data: Record<string, unknown>, surfaceOp?: string): void => {
    events.push({
      type,
      seq: events.length,
      time: 1700000000000 + events.length,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    });
  };
  add("turn/start", { turn: 1 });
  add(
    "user/message",
    {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "fixture request" }],
    },
    "append",
  );
  const result = (callId: string, text: string, error: boolean): void => {
    const body =
      mode === "dsh-custom-ptc"
        ? `<dsh-result tool="run_code" call="${callId}">\n${text}\n</dsh-result>`
        : text;
    add(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId },
          toolCallId: callId,
          isError: error,
          content: [{ type: "text", text: body }],
        },
      },
      "append",
    );
  };
  if (ptc) {
    const callId = "root-call";
    const code = `${calls
      .map((call) => `await tools["${call.name}"](${JSON.stringify(call.args)});`)
      .join("\n")}\nreturn null;`;
    add(
      "tool/call",
      {
        turn: 1,
        step: 1,
        callId,
        name: "run_code",
        arguments: JSON.stringify(
          mode === "dsh-custom-ptc"
            ? { code, description: "fixture", input: {} }
            : { code, description: "fixture" },
        ),
      },
      "append",
    );
    calls.forEach((call, index) => {
      const common = {
        rootCallId: callId,
        parentCallId: callId,
        subCallId: `${callId}:ptc:${index + 1}`,
        name: call.name,
        arguments: call.args,
      };
      const content =
        call.name === "read_image"
          ? [
              { type: "text", text: call.result },
              {
                type: "image",
                attachment: {
                  attachmentId: "synthetic-image-id",
                  mediaType: "image/png",
                  bytes: 68,
                  width: 1,
                  height: 1,
                },
              },
            ]
          : [{ type: "text", text: call.result }];
      add("tool/ptc-dispatch-start", common);
      add("tool/ptc-dispatch", {
        ...common,
        isError: call.error === true,
        content,
      });
      if (call.name === "read_image")
        add("user/message", { role: "user", source: { kind: "ptc-mode" }, content }, "append");
    });
    result(callId, "FAILMARK", true);
  } else {
    calls.forEach((call, index) => {
      const callId = `direct-${index}`;
      add(
        "tool/call",
        { turn: 1, step: 1, callId, name: call.name, arguments: JSON.stringify(call.args) },
        "append",
      );
      result(callId, call.result, call.error === true);
    });
  }
  add("turn/end", { turn: 1 });
  writeFixtureHome(home, {
    sessions: [
      {
        id,
        projectDir: "fixture",
        createdAt: 1700000000000,
        agentPreset: mode,
        events,
        projcache: "missing",
      },
    ],
  });
  return { home, id };
}

function runCli(home: string, args: string[], format: string) {
  const out = join(home, "output");
  return spawnSync(
    "node",
    [
      script,
      ...args,
      "--dsh-home",
      home,
      "--output-dir",
      out,
      "--name",
      "result",
      "--format",
      format,
    ],
    { encoding: "utf8" },
  );
}

function cli(home: string, args: string[], format: string): string {
  const out = join(home, "output");
  const run = runCli(home, args, format);
  assert.equal(run.status, 0, `CLI 失败：${run.stderr}`);
  assert.equal(run.stderr, "");
  return readFileSync(join(out, `result.${format}`), "utf8");
}

describe("正式 CLI 的四种预设记录", () => {
  for (const mode of ["standard", "cordis", "ptc", "dsh-custom-ptc"] as const) {
    it(`${mode} 的原始事件保留实际子调用标识`, () => {
      const { home, id } = fixture(mode);
      const lines = cli(home, ["show", id], "jsonl").trim().split("\n");
      const events = lines.slice(1).map((line) => JSON.parse(line));
      if (mode === "ptc" || mode === "dsh-custom-ptc") {
        const start = events.find(
          (event) => event.type === "tool/ptc-dispatch-start" && event.data.name === "read",
        );
        const end = events.find(
          (event) => event.type === "tool/ptc-dispatch" && event.data.name === "read",
        );
        assert.equal(start.data.rootCallId, "root-call");
        assert.equal(start.data.parentCallId, "root-call");
        assert.equal(start.data.subCallId, "root-call:ptc:3");
        assert.equal(end.data.subCallId, start.data.subCallId);
        assert.equal(end.data.content[0].text, "RESULTMARK");
      }
    });
    it(`${mode} 的统计输出不含活动数量`, () => {
      const { home, id } = fixture(mode);
      const md = cli(home, ["show", id], "md");
      for (const label of ["- 轮次：", "；步数：", "- 工具调用：", "；工具调用：", "- 令牌："])
        assert.equal(md.includes(label), false, label);
      const json = JSON.parse(cli(home, ["stats", id], "json"));
      for (const key of ["turns", "steps", "toolCalls", "tokens"])
        assert.equal(Object.hasOwn(json.session, key), false, key);
      assert.equal(json.session.hasToolCalls, true);
      assert.ok(json.session.sizeBytes > 0);
    });
    if (mode === "ptc" || mode === "dsh-custom-ptc") {
      it(`${mode} 无附件文件时保留图片原始引用并导出文本`, () => {
        const { home, id } = fixture(mode);
        const raw = cli(home, ["show", id], "jsonl");
        const events = raw
          .trim()
          .split("\n")
          .slice(1)
          .map((line) => JSON.parse(line));
        const imageMessage = events.find(
          (event) => event.type === "user/message" && event.data.source.kind === "ptc-mode",
        );
        assert.deepEqual(imageMessage.data.content[1], {
          type: "image",
          attachment: {
            attachmentId: "synthetic-image-id",
            mediaType: "image/png",
            bytes: 68,
            width: 1,
            height: 1,
          },
        });
        assert.ok(cli(home, ["show", id], "md").includes("fixture request"));
      });
      it(`${mode} 的 JSON 和标头保留子调用的身份`, () => {
        const { home, id } = fixture(mode);
        const json = JSON.parse(cli(home, ["show", id], "json"));
        const start = json.messages.find(
          (entry: Record<string, unknown>) =>
            entry.type === "tool/ptc-dispatch-start" && entry.callId === "root-call:ptc:3",
        );
        const end = json.messages.find(
          (entry: Record<string, unknown>) =>
            entry.type === "tool/ptc-dispatch" && entry.callId === "root-call:ptc:3",
        );
        assert.ok(start);
        assert.ok(end);
        assert.equal(start.role, "tool");
        assert.equal(start.rootCallId, "root-call");
        assert.equal(start.parentCallId, "root-call");
        assert.equal(start.arguments, JSON.stringify({ file_path: "fixture.txt" }));
        assert.equal(end.role, "tool");
        assert.equal(end.rootCallId, "root-call");
        assert.equal(end.parentCallId, "root-call");
        const failed = json.messages.find(
          (entry: Record<string, unknown>) =>
            entry.type === "tool/ptc-dispatch" &&
            entry.isError === true &&
            typeof entry.text === "string" &&
            entry.text.includes("FAILMARK"),
        );
        assert.ok(failed);
        const md = cli(home, ["show", id, "--tools", "--headers"], "md");
        assert.ok(md.includes("root-call:ptc:3"));
        assert.ok(md.includes("root-call"));
      });
      it(`${mode} 的工具检索命中子调用结果而非外层程序`, () => {
        const { home, id } = fixture(mode);
        const found = JSON.parse(
          cli(home, ["search", "RESULTMARK", "--session", id, "--scope", "tools"], "json"),
        );
        assert.ok(
          found.matches.some((match: { label: string }) => match.label === "tool/ptc-dispatch"),
        );
      });
    }
    it(`呈现和检索 ${mode} 的工具记录`, () => {
      const { home, id } = fixture(mode);
      const md = cli(home, ["show", id], "md");
      assert.match(md, /子代理任务/);
      assert.match(md, /TASKMARK/);
      assert.match(md, /发往子代理/);
      assert.match(md, /MESSAGEMARK/);
      if (mode !== "dsh-custom-ptc") {
        assert.match(md, /提问/);
        assert.match(md, /QUESTIONMARK/);
        assert.match(md, /回答/);
        assert.match(md, /ANSWERMARK/);
      }
      const detailed = cli(home, ["show", id, "--tools"], "md");
      assert.match(detailed, /RESULTMARK/);
      assert.match(detailed, /FAILMARK/);
      assert.match(detailed, /工具结果.*错误/);
      if (mode === "dsh-custom-ptc") {
        assert.match(detailed, /MCPMARK/);
        assert.match(detailed, /CREATIONMARK/);
      }
      for (const word of mode === "dsh-custom-ptc"
        ? ["TASKMARK", "MESSAGEMARK"]
        : ["TASKMARK", "MESSAGEMARK", "QUESTIONMARK", "ANSWERMARK"]) {
        const found = JSON.parse(
          cli(home, ["search", word, "--session", id, "--scope", "text"], "json"),
        );
        assert.ok(found.total > 0, word);
      }
      const found = JSON.parse(
        cli(home, ["search", "RESULTMARK", "--session", id, "--scope", "tools"], "json"),
      );
      assert.ok(found.total > 0);
      const all = JSON.parse(
        cli(home, ["search", "RESULTMARK", "--session", id, "--scope", "all"], "json"),
      );
      assert.ok(all.total > 0);
      const jsonl = cli(home, ["show", id], "jsonl");
      assert.match(jsonl, /RESULTMARK/);
      if (mode === "ptc" || mode === "dsh-custom-ptc") assert.match(jsonl, /tool\/ptc-dispatch/);
      const json = JSON.parse(cli(home, ["show", id], "json"));
      assert.equal(json.meta.hasToolCalls, true);
      assert.equal(Object.hasOwn(json.meta, "toolCalls"), false);
      const stats = JSON.parse(cli(home, ["stats", id], "json"));
      assert.equal(stats.session.hasToolCalls, true);
      assert.equal(Object.hasOwn(stats.session, "toolCalls"), false);
      if (mode === "ptc" || mode === "dsh-custom-ptc") {
        const dispatch = json.messages.find(
          (entry: Record<string, unknown>) =>
            entry.type === "tool/ptc-dispatch" && entry.callId === "root-call:ptc:3",
        );
        assert.ok(dispatch);
        assert.equal(dispatch.role, "tool");
        assert.equal(dispatch.rootCallId, "root-call");
        assert.equal(dispatch.parentCallId, "root-call");
        assert.equal(dispatch.arguments, JSON.stringify({ file_path: "fixture.txt" }));
      } else {
        const direct = json.messages.find(
          (entry: Record<string, unknown>) => entry.type === "tool/call",
        );
        assert.ok(direct);
        assert.equal(Object.hasOwn(direct, "rootCallId"), false);
        assert.equal(Object.hasOwn(direct, "parentCallId"), false);
      }
    });
  }

  it("拒绝已移除的轮次排序", () => {
    const { home } = fixture("standard");
    const run = runCli(home, ["list", "--sort", "turns"], "md");
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.ok(run.stderr.includes("参数无效"));
  });

  it("摘要保留轮次大纲但终端不报告轮次总数", () => {
    const { home, id } = fixture("standard");
    const run = runCli(home, ["show", id, "--summary"], "md");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout.includes("轮次"), false);
    const md = readFileSync(join(home, "output", "result.md"), "utf8");
    assert.ok(md.includes("轮次大纲"));
    assert.ok(md.includes("fixture request"));
  });

  it("规模探测不报告消息数或问答数", () => {
    const { home, id } = fixture("standard");
    const md = cli(home, ["show", id, "--probe"], "md");
    assert.equal(md.includes("消息数"), false);
    assert.equal(md.includes("问答数"), false);
    assert.ok(md.includes("字节"));
  });

  it("列表和全局概况保留覆盖与规模但删除活动数量", () => {
    const { home } = fixture("standard");
    const list = JSON.parse(cli(home, ["list"], "json"));
    assert.ok(list.coverage);
    assert.ok(list.sessions[0].sizeBytes > 0);
    for (const key of ["turns", "steps", "toolCalls", "tokens"])
      assert.equal(Object.hasOwn(list.sessions[0], key), false, key);
    const stats = JSON.parse(cli(home, ["stats"], "json"));
    assert.ok(stats.coverage);
    assert.ok(stats.totalSizeBytes > 0);
    for (const key of ["turns", "steps", "toolCalls", "tokens"])
      assert.equal(Object.hasOwn(stats, key), false, key);
  });

  it("无工具调用的会话标记为否", () => {
    const home = join(temp, "no-tools", "home");
    const id = "session-fixture-no-tools";
    writeFixtureHome(home, {
      sessions: [
        {
          id,
          projectDir: "fixture",
          createdAt: 1700000000000,
          agentPreset: "standard",
          projcache: "missing",
          events: [
            { type: "turn/start", seq: 0, time: 1700000000000, data: { turn: 1 } },
            {
              type: "user/message",
              seq: 1,
              time: 1700000000001,
              surfaceOp: "append",
              data: {
                role: "user",
                source: { kind: "user" },
                content: [{ type: "text", text: "无工具请求" }],
              },
            },
            { type: "turn/end", seq: 2, time: 1700000000002, data: { turn: 1 } },
          ],
        },
      ],
    });
    const json = JSON.parse(cli(home, ["show", id], "json"));
    assert.equal(json.meta.hasToolCalls, false);
    const stats = JSON.parse(cli(home, ["stats", id], "json"));
    assert.equal(stats.session.hasToolCalls, false);
  });
});
