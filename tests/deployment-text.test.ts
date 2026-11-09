// 部署包装解析的单元测试：完整信封才剥离、不完整原样返回、两个顺序信封、严格版与宽松版的差异、
// 消息信封的宽松剥离与转义终点、内层引用的消息标记行对与标题归一化。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  leadingInjectionKind,
  normalizeSessionTitle,
  stripInjectionEnvelopes,
  stripMessageEnvelope,
  stripNestedMessageMarkers,
  stripResultEnvelope,
  stripResultEnvelopeLenient,
} from "../scripts/lib/deployment-text.ts";

const INJECTION_OPEN = '<dsh-injection kind="time-context" src="time-context" id="abc">';
const RESULT_OPEN = '<dsh-result tool="pwsh" call="call-1">';
const MESSAGE_TS = "2026-10-29T22:59:57+08:00";
const MESSAGE_OPEN = `<dsh-message role="user" id="abcdef12" ts="${MESSAGE_TS}">`;
const ASSISTANT_OPEN = `<dsh-message role="assistant" id="abcdef12" ts="${MESSAGE_TS}">`;
/**
 * 消息终点的转义形态。
 *
 * 外层包裹对内层终点统一转义（`preset-lib/injection-boundary.mjs` 的 `wrapSegments`），转义后的
 * 字面量在文本里是“反斜杠 + 斜杠 + 标签名”，因此源码里必须写两个反斜杠才表示一个反斜杠。
 */
const ESCAPED_CLOSE = "<\\/dsh-message>";

describe("stripInjectionEnvelopes", () => {
  it("剥离一个完整信封", () => {
    assert.equal(
      stripInjectionEnvelopes(`${INJECTION_OPEN}\n正文第一行\n正文第二行\n</dsh-injection>`),
      "正文第一行\n正文第二行",
    );
  });

  it("剥离两个顺序排列的信封（子代理任务与回报指引）", () => {
    const task = '<dsh-injection kind="subagent-task" src="s-1" id="t1">';
    const guidance = '<dsh-injection kind="subagent-return-guidance" src="dsh-subagent" id="t1">';
    assert.equal(
      stripInjectionEnvelopes(
        `${task}\n任务正文\n</dsh-injection>\n${guidance}\n回报指引\n</dsh-injection>`,
      ),
      "任务正文\n回报指引",
    );
  });

  it("不以起点开头时原样返回", () => {
    assert.equal(stripInjectionEnvelopes("普通正文"), "普通正文");
    assert.equal(
      stripInjectionEnvelopes(`前缀\n${INJECTION_OPEN}\n正文\n</dsh-injection>`),
      `前缀\n${INJECTION_OPEN}\n正文\n</dsh-injection>`,
    );
  });

  it("信封不完整时原样返回，不尽力截取", () => {
    assert.equal(stripInjectionEnvelopes(`${INJECTION_OPEN}\n正文`), `${INJECTION_OPEN}\n正文`);
    assert.equal(
      stripInjectionEnvelopes(`${INJECTION_OPEN}正文\n</dsh-injection>`),
      `${INJECTION_OPEN}正文\n</dsh-injection>`,
    );
  });

  it("信封后仍有残余内容时原样返回", () => {
    const text = `${INJECTION_OPEN}\n正文\n</dsh-injection>\n尾部`;
    assert.equal(stripInjectionEnvelopes(text), text);
  });

  it("正文里的转义终点不参与边界判定", () => {
    const text = `${INJECTION_OPEN}\n正文 <\\/dsh-injection> 仍在正文里\n</dsh-injection>`;
    assert.equal(stripInjectionEnvelopes(text), "正文 <\\/dsh-injection> 仍在正文里");
  });
});

describe("stripResultEnvelope（严格版，问答载荷使用）", () => {
  it("裸正文原样返回", () => {
    assert.equal(stripResultEnvelope('{"answers":[]}'), '{"answers":[]}');
  });

  it("完整信封剥离", () => {
    assert.equal(
      stripResultEnvelope(`${RESULT_OPEN}\n{"answers":[]}\n</dsh-result>`),
      '{"answers":[]}',
    );
  });

  it("信封不完整返回 null", () => {
    assert.equal(stripResultEnvelope(`${RESULT_OPEN}\n{"answers":[]}`), null);
    assert.equal(stripResultEnvelope(RESULT_OPEN), null);
    assert.equal(stripResultEnvelope(`${RESULT_OPEN}\n\n</dsh-result>`), "");
  });
});

describe("stripResultEnvelopeLenient（展示面使用）", () => {
  it("完整信封剥离，不完整原样返回", () => {
    assert.equal(stripResultEnvelopeLenient(`${RESULT_OPEN}\n正文\n</dsh-result>`), "正文");
    const broken = `${RESULT_OPEN}\n正文`;
    assert.equal(stripResultEnvelopeLenient(broken), broken);
    const trailing = `${RESULT_OPEN}\n正文\n</dsh-result>\n尾部`;
    assert.equal(stripResultEnvelopeLenient(trailing), trailing);
  });
});

describe("stripMessageEnvelope（展示面与检索面的宽松版）", () => {
  it("剥离一个完整的用户消息信封", () => {
    assert.equal(
      stripMessageEnvelope(`${MESSAGE_OPEN}\n正文第一行\n正文第二行\n</dsh-message>`),
      "正文第一行\n正文第二行",
    );
  });

  it("助手角色的信封同样剥离", () => {
    const open = `<dsh-message role="assistant" id="abcdef12" ts="${MESSAGE_TS}">`;
    assert.equal(stripMessageEnvelope(`${open}\n回答正文\n</dsh-message>`), "回答正文");
  });

  it("不以起点开头时原样返回", () => {
    assert.equal(stripMessageEnvelope("普通正文"), "普通正文");
    assert.equal(
      stripMessageEnvelope(`前缀\n${MESSAGE_OPEN}\n正文\n</dsh-message>`),
      `前缀\n${MESSAGE_OPEN}\n正文\n</dsh-message>`,
    );
  });

  it("信封不完整时原样返回", () => {
    assert.equal(stripMessageEnvelope(`${MESSAGE_OPEN}\n正文`), `${MESSAGE_OPEN}\n正文`);
    assert.equal(
      stripMessageEnvelope(`${MESSAGE_OPEN}正文\n</dsh-message>`),
      `${MESSAGE_OPEN}正文\n</dsh-message>`,
    );
  });

  it("终点之后还有内容时原样返回", () => {
    const text = `${MESSAGE_OPEN}\n正文\n</dsh-message>\n尾部`;
    assert.equal(stripMessageEnvelope(text), text);
  });

  it("内层被外层转义的终点不构成终点", () => {
    // 注入信封的正文引用了一条带消息信封的消息时，写入侧的 `wrapSegments` 会把内层终点转义为
    // `<\/dsh-message>`（防伪）。该形态不是完整信封，必须原样返回，不得截到转义终点之前。
    const text = `${MESSAGE_OPEN}\n正文 <\\/dsh-message> 仍在正文里\n</dsh-message>`;
    assert.equal(stripMessageEnvelope(text), "正文 <\\/dsh-message> 仍在正文里");
  });

  it("空正文信封剥离后返回空串", () => {
    assert.equal(stripMessageEnvelope(`${MESSAGE_OPEN}\n\n</dsh-message>`), "");
  });
});

describe("leadingInjectionKind（合成消息判定的结构读取）", () => {
  const OPEN = '<dsh-injection kind="context-compacted" src="handoff" id="abcdef12">';

  it("完整起点行给出 kind 取值", () => {
    assert.equal(leadingInjectionKind(`${OPEN}\n正文\n</dsh-injection>`), "context-compacted");
  });

  it("起点行之前没有换行时不命中（起点行未结束）", () => {
    assert.equal(leadingInjectionKind(OPEN), null);
  });

  it("起点行不以 > 收尾时不命中（正文写进起点行）", () => {
    assert.equal(
      leadingInjectionKind(`<dsh-injection kind="context-compacted" src="handoff"\n正文`),
      null,
    );
  });

  it("不以注入起点前缀开头时一律不命中", () => {
    assert.equal(leadingInjectionKind(`前缀\n${OPEN}\n正文`), null);
    assert.equal(leadingInjectionKind("<dsh-injection>\n正文"), null);
  });

  it("kind 属性缺失或为空时不命中", () => {
    assert.equal(leadingInjectionKind('<dsh-injection src="handoff">\n正文'), null);
    assert.equal(leadingInjectionKind('<dsh-injection kind="" src="handoff">\n正文'), null);
  });

  it("只解析起点行，正文里的同形文字不参与判定", () => {
    assert.equal(
      leadingInjectionKind(`${OPEN}\n正文 <dsh-injection kind="other" src="x"> 之后的文字`),
      "context-compacted",
    );
  });
});

describe("stripNestedMessageMarkers（内层引用的消息标记行对）", () => {
  const OPEN_LINE = ASSISTANT_OPEN;

  it("成对时只删这两行，中间正文逐字保留", () => {
    const text = ["引用前文", OPEN_LINE, "引用正文", ESCAPED_CLOSE, "引用后文"].join("\n");
    assert.equal(stripNestedMessageMarkers(text), ["引用前文", "引用正文", "引用后文"].join("\n"));
  });

  it("起点行两侧的空白不影响识别，被删的行连同其换行一起消失", () => {
    const text = ["前文", `  ${OPEN_LINE}  `, "正文", `  ${ESCAPED_CLOSE}  `, "后文"].join("\n");
    assert.equal(stripNestedMessageMarkers(text), ["前文", "正文", "后文"].join("\n"));
  });

  it("只有起点、只有终点、终点未转义时整段原样返回", () => {
    const onlyOpen = ["前文", OPEN_LINE, "正文"].join("\n");
    assert.equal(stripNestedMessageMarkers(onlyOpen), onlyOpen);
    const onlyClose = ["前文", ESCAPED_CLOSE, "正文"].join("\n");
    assert.equal(stripNestedMessageMarkers(onlyClose), onlyClose);
    const unescaped = ["前文", OPEN_LINE, "正文", "</dsh-message>", "后文"].join("\n");
    assert.equal(stripNestedMessageMarkers(unescaped), unescaped);
  });

  it("标记混在行内时不处理", () => {
    const inline = `前文 ${OPEN_LINE} 正文 ${ESCAPED_CLOSE} 后文`;
    assert.equal(stripNestedMessageMarkers(inline), inline);
    const headWithText = ["前文", `${OPEN_LINE}同一行的正文`, ESCAPED_CLOSE].join("\n");
    assert.equal(stripNestedMessageMarkers(headWithText), headWithText);
  });

  it("多个成对按出现顺序逐个处理", () => {
    const text = [
      "第一段",
      OPEN_LINE,
      "引用一",
      ESCAPED_CLOSE,
      "第二段",
      OPEN_LINE,
      "引用二",
      ESCAPED_CLOSE,
      "结尾",
    ].join("\n");
    assert.equal(
      stripNestedMessageMarkers(text),
      ["第一段", "引用一", "第二段", "引用二", "结尾"].join("\n"),
    );
  });

  it("幂等：对结果再调用一次不再变化", () => {
    const text = ["前文", OPEN_LINE, "正文", ESCAPED_CLOSE].join("\n");
    const once = stripNestedMessageMarkers(text);
    assert.equal(stripNestedMessageMarkers(once), once);
  });

  it("只有一个终点、前面有多个起点时只与第一个起点成对", () => {
    const text = ["开头", OPEN_LINE, "甲", OPEN_LINE, "乙", ESCAPED_CLOSE, "结尾"].join("\n");
    // 第一个起点与唯一的转义终点成对，被删；夹在中间的第二个起点没有后续终点，保留。
    assert.equal(
      stripNestedMessageMarkers(text),
      ["开头", "甲", OPEN_LINE, "乙", "结尾"].join("\n"),
    );
  });
});

describe("normalizeSessionTitle（标题归一化）", () => {
  it("四种部署标记起点一律视为没有标题", () => {
    for (const prefix of [
      '<dsh-injection kind="subagent-task" src=',
      '<dsh-message role="assistant" id=',
      '<dsh-result tool="read" call=',
      "<compacted-summary>",
    ]) {
      assert.equal(normalizeSessionTitle(prefix), null, prefix);
      assert.equal(normalizeSessionTitle(`  ${prefix}xxx  `), null, prefix);
    }
  });

  it("正常标题去掉首尾空白后原样返回", () => {
    assert.equal(normalizeSessionTitle("  会话标题  "), "会话标题");
    assert.equal(normalizeSessionTitle("会话标题"), "会话标题");
  });

  it("以 < 开头但不是标记的标题照常可用", () => {
    assert.equal(normalizeSessionTitle("<dsh-other 说明"), "<dsh-other 说明");
    assert.equal(normalizeSessionTitle("<html>标题"), "<html>标题");
  });

  it("空串、纯空白与 null 都收敛为 null", () => {
    assert.equal(normalizeSessionTitle(""), null);
    assert.equal(normalizeSessionTitle("   "), null);
    assert.equal(normalizeSessionTitle(null), null);
    assert.equal(normalizeSessionTitle(undefined), null);
  });
});
