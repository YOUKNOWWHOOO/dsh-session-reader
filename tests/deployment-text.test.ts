// 部署包装解析的单元测试：完整信封才剥离、不完整原样返回、两个顺序信封、严格版与宽松版的差异、
// `<compacted-summary>` 只认整段完整信封。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactedSummaryBody,
  stripInjectionEnvelopes,
  stripResultEnvelope,
  stripResultEnvelopeLenient,
} from "../scripts/lib/deployment-text.ts";

const INJECTION_OPEN = '<dsh-injection kind="time-context" src="time-context" id="abc">';
const RESULT_OPEN = '<dsh-result tool="pwsh" call="call-1">';

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

describe("compactedSummaryBody", () => {
  it("完整信封取内层正文", () => {
    assert.equal(compactedSummaryBody("<compacted-summary>\n摘要\n</compacted-summary>"), "摘要");
  });

  it("官方检查点前言在信封外时不命中", () => {
    assert.equal(
      compactedSummaryBody(
        "这是自动生成的检查点前言。\n\n<compacted-summary>\n摘要\n</compacted-summary>",
      ),
      null,
    );
  });

  it("缺少成对换行时不命中", () => {
    assert.equal(compactedSummaryBody("<compacted-summary>摘要</compacted-summary>"), null);
    assert.equal(compactedSummaryBody("<compacted-summary>\n摘要"), null);
  });
});
