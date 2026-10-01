// 用途：全组合 lint 门禁的组合矩阵词汇表与呈现类组合定义（list / show 的命令×参数枚举与边界补充）。
// 主要入口：listCases、showCases（返回逐组合用例），以及 mcase/healthyBase 公共构造器。
// 关键依赖：./matrix-paths.ts（官方库锚点）、./matrix-fixtures.ts（夹具会话 id/工作目录与健康夹具定义）。
// 设计约束：组合只增不减；每个用例的期望退出码、期望 stdout 契约与期望 stderr 全文都必须显式声明，
//           禁止用"跳过/容忍"代替判定。查询类与校验类组合见 ./matrix-cases-query.ts。

import {
  ASK_ERROR_ID,
  ASK_MALFORMED_ID,
  ASK_PAIRED_ID,
  ASK_UNPAIRED_ID,
  CHILD_ID,
  healthySpec,
  MAIN_CWD,
  MAIN_ID,
} from "./matrix-fixtures.ts";
import { libRoot } from "./matrix-paths.ts";

// ------------------------- 组合矩阵定义 -------------------------

/** 组合产物的形态：md / json / jsonl，none 表示错误路径不产出文件。 */
export type OutputKind = "md" | "json" | "jsonl" | "none";

/** json 产物的结构形态（none 形态为 null）。 */
export type JsonShape = "list" | "show" | "search" | "stats" | "check" | "jsonl" | null;

export interface MatrixCase {
  readonly id: string;
  readonly args: readonly string[];
  readonly kind: OutputKind;
  readonly shape: JsonShape;
  readonly expectExit: number;
  readonly expectOutput: boolean;
  /** true 时不为该组合自动追加 --output-dir（用于"缺少输出目录"错误路径）。 */
  readonly omitOutputDir: boolean;
  /** 期望的 stderr 全文：错误路径必填（含候选数形态）；成功路径必须为空串。 */
  readonly expectStderr: string;
}

/** 歧义前缀 "session-adv-" 可匹配的健康夹具会话数（全部 13 个会话 id 均以该前缀开头）。 */
const HEALTHY_SESSION_COUNT = healthySpec().sessions.length;

const LIST_SORTS = ["time", "created", "title", "size", "turns"] as const;
/** 来源枚举：list/search/stats 的 --origin 取值全集。 */
export const ORIGINS = ["all", "main", "subagent"] as const;
const SHOW_SWITCHES = [
  "--summary",
  "--thinking",
  "--tools",
  "--events",
  "--subagents",
  "--headers",
] as const;
const SHOW_TARGETS = [MAIN_ID, CHILD_ID, "adv-main", "last"] as const;
const SPECIAL_IDS = [
  "session-adv-lines-02",
  "session-adv-dollar-03",
  "session-adv-tab-04",
  "session-adv-crlf-05",
  "session-adv-blank-06",
  "session-adv-empty-09",
  "session-adv-nopc-10",
  "session-adv-pcver-11",
  "session-adv-pcid-12",
  "session-adv-pcpart-13",
  // 三个可完整导出的问答样本：默认可见、开关全开（--tools 时原始工具条目与问答条目并存）、
  // 范围选择（--seq 0-3 只截到部分问答事件）三条路径都因此在全组合层面受检。
  // 结构不符的样本（ASK_MALFORMED_ID）**不得**列入本表：它的期望是退出 3，与这里的期望 0 冲突。
  ASK_PAIRED_ID,
  ASK_UNPAIRED_ID,
  ASK_ERROR_ID,
] as const;

export interface MatrixCaseOptions {
  readonly omitOutputDir?: boolean;
  readonly expectStderr?: string;
}

export function mcase(
  id: string,
  args: readonly string[],
  kind: OutputKind,
  shape: JsonShape,
  expectExit: number,
  options: MatrixCaseOptions = {},
): MatrixCase {
  return {
    id,
    args,
    kind,
    shape,
    expectExit,
    expectOutput: kind !== "none",
    omitOutputDir: options.omitOutputDir ?? false,
    expectStderr: options.expectStderr ?? "",
  };
}

/** 健康夹具的公共参数前缀（--lib-root 显式锚定官方库，避免使用真实 dsh 主目录）。 */
export function healthyBase(): string[] {
  return ["--dsh-home", "HEALTHY", "--lib-root", libRoot()];
}

/** list 组合：20 条开关交叉 + 显式边界 + json 形态 + 错误路径。 */
export function listCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const workspaces = [null, "user_projects", MAIN_CWD] as const;
  const bounds = [null, "0", "9999999999999"] as const;
  const titles = [null, "needle", "zzznomatch"] as const;
  const limits = [0, 1, 100] as const;
  for (let index = 0; index < 20; index += 1) {
    const args = ["list", ...healthyBase()];
    if (index % 2 === 1) args.push("--include-blank");
    if (index >= 10) args.push("--full");
    args.push("--sort", LIST_SORTS[index % 5], "--origin", ORIGINS[index % 3]);
    const workspace = workspaces[index % 3];
    if (workspace !== null) args.push("--workspace", workspace);
    const since = bounds[index % 3];
    if (since !== null) args.push("--since", since);
    const until = bounds[(index + 1) % 3];
    if (until !== null) args.push("--until", until);
    const title = titles[index % 3];
    if (title !== null) args.push("--title", title);
    args.push("--limit", String(limits[index % 3]));
    cases.push(mcase(`list-md-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase("list-md-default", ["list", ...healthyBase()], "md", null, 0),
    mcase("list-md-explicit-format", ["list", ...healthyBase(), "--format", "md"], "md", null, 0),
    mcase(
      "list-md-boundary-since-until",
      ["list", ...healthyBase(), "--since", "0", "--until", "0"],
      "md",
      null,
      0,
    ),
    mcase("list-md-include-blank", ["list", ...healthyBase(), "--include-blank"], "md", null, 0),
    mcase(
      "list-md-limit-1-created",
      ["list", ...healthyBase(), "--limit", "1", "--sort", "created"],
      "md",
      null,
      0,
    ),
    mcase(
      "list-md-zero-match-title",
      ["list", ...healthyBase(), "--title", "zzznomatch"],
      "md",
      null,
      0,
    ),
    mcase("list-md-default-lib-anchor", ["list", "--dsh-home", "HEALTHY"], "md", null, 0),
  );
  for (let index = 0; index < 5; index += 1) {
    const args = ["list", ...healthyBase(), "--format", "json"];
    if (index % 2 === 0) args.push("--include-blank");
    if (index >= 3) args.push("--full");
    args.push("--origin", ORIGINS[index % 3], "--limit", ["0", "100"][index % 2]);
    cases.push(mcase(`list-json-${index}`, args, "json", "list", 0));
  }
  cases.push(
    mcase("err-list-jsonl", ["list", ...healthyBase(), "--format", "jsonl"], "none", null, 2, {
      expectStderr: "错误: 参数无效（选项值无效: --format）\n",
    }),
    mcase("err-list-text", ["list", ...healthyBase(), "--format", "text"], "none", null, 2, {
      expectStderr: "错误: 参数无效（选项值无效: --format）\n",
    }),
    mcase("err-list-no-output-dir", ["list", "--dsh-home", "HEALTHY"], "none", null, 2, {
      omitOutputDir: true,
      expectStderr: "错误: 参数无效（缺少 --output-dir）\n",
    }),
    mcase(
      "err-list-missing-home",
      ["list", "--dsh-home", "NO_SUCH_HOME", "--lib-root", libRoot()],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "err-list-bad-workspace",
      ["list", ...healthyBase(), "--workspace", "no-such-workspace"],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
  );
  return cases;
}

/** show 组合：6 开关 64 全交叉 × 角色 × 截断 + 特殊会话 + 范围穷尽 + 探测/错误路径。 */
export function showCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const roles = [null, "user", "assistant"] as const;
  const truncates = [0, 1, 50, 2000] as const;
  // 全笛卡尔：6 开关 64 组合 × 角色 3 × 截断 4 = 768（排列目标 × 角色 × 截断以分散目标覆盖）。
  for (let switchIndex = 0; switchIndex < 64; switchIndex += 1) {
    for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
      for (let truncateIndex = 0; truncateIndex < truncates.length; truncateIndex += 1) {
        const target = SHOW_TARGETS[(switchIndex + roleIndex + truncateIndex) % 4];
        const args = ["show", target, ...healthyBase()];
        for (let bit = 0; bit < 6; bit += 1) {
          if (((switchIndex >> bit) & 1) === 1) args.push(SHOW_SWITCHES[bit]);
        }
        const role = roles[roleIndex];
        if (role !== null) args.push("--role", role);
        const truncate = truncates[truncateIndex];
        if (truncate !== 0) args.push("--truncate", String(truncate));
        cases.push(
          mcase(`show-md-${switchIndex}-${roleIndex}-${truncateIndex}`, args, "md", null, 0),
        );
      }
    }
  }
  for (const id of SPECIAL_IDS) {
    cases.push(
      mcase(`show-md-special-default-${id}`, ["show", id, ...healthyBase()], "md", null, 0),
    );
    cases.push(
      mcase(
        `show-md-special-visible-${id}`,
        ["show", id, ...healthyBase(), "--thinking", "--tools", "--events", "--headers"],
        "md",
        null,
        0,
      ),
    );
    cases.push(
      mcase(
        `show-md-special-range-${id}`,
        ["show", id, ...healthyBase(), "--turn", "1-2", "--seq", "0-3", "--events"],
        "md",
        null,
        0,
      ),
    );
  }
  // 范围选择穷尽：--turn/--seq 区间与单值形态 × --head/--tail × 可见性开关。
  const turnArgs = ["1", "1-1", "1-2", "0-1"] as const;
  const seqArgs = ["0", "0-0", "0-2", "2-4"] as const;
  for (let index = 0; index < 16; index += 1) {
    const args = ["show", SHOW_TARGETS[index % 4], ...healthyBase()];
    if (index % 4 !== 3) args.push("--turn", turnArgs[index % 4]);
    if (index % 4 !== 2) args.push("--seq", seqArgs[index % 4]);
    if (index % 3 === 0) args.push("--events", "--headers");
    if (index % 3 === 1) args.push("--thinking", "--tools");
    if (index % 5 === 0) args.push("--head", "2");
    if (index % 5 === 1) args.push("--tail", "2");
    cases.push(mcase(`show-md-range-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase("show-md-head-zero", ["show", MAIN_ID, ...healthyBase(), "--head", "0"], "md", null, 0),
    mcase("show-md-tail-zero", ["show", MAIN_ID, ...healthyBase(), "--tail", "0"], "md", null, 0),
    mcase(
      "show-md-range-with-subagents",
      ["show", MAIN_ID, ...healthyBase(), "--subagents", "--turn", "1-1"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-range-out-of-bounds",
      ["show", MAIN_ID, ...healthyBase(), "--turn", "98-99"],
      "md",
      null,
      0,
    ),
    mcase(
      "err-show-head-tail",
      ["show", MAIN_ID, ...healthyBase(), "--head", "1", "--tail", "1"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--head 与 --tail 不能同时使用；只保留其中一个）\n" },
    ),
    mcase(
      "err-show-summary-turn",
      ["show", MAIN_ID, ...healthyBase(), "--summary", "--turn", "1"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--summary 与 --turn 不能同时使用；去掉 --turn，或去掉 --summary）\n",
      },
    ),
    mcase(
      "err-show-bad-turn",
      ["show", MAIN_ID, ...healthyBase(), "--turn", "0"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--turn 取值应为 <A-B> 或 <A>（正整数，B 不小于 A））\n" },
    ),
    mcase(
      "err-show-bad-seq",
      ["show", MAIN_ID, ...healthyBase(), "--seq", "3-1"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--seq 取值应为 <A-B> 或 <A>（非负整数，B 不小于 A））\n" },
    ),
    mcase(
      "err-show-json-turn",
      ["show", MAIN_ID, ...healthyBase(), "--format", "json", "--turn", "1"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（呈现类开关 --turn 仅 md 可用；去掉 --turn，或把 --format 改为 md）\n",
      },
    ),
    // --probe：规模探测。与呈现类开关同用允许（按同组选项量字节数），与内容范围开关同用拒绝。
    mcase("show-md-probe", ["show", MAIN_ID, ...healthyBase(), "--probe"], "md", null, 0),
    mcase(
      "show-md-probe-with-switches",
      ["show", MAIN_ID, ...healthyBase(), "--probe", "--events", "--tools", "--truncate", "30"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-probe-special",
      ["show", "session-adv-dollar-03", ...healthyBase(), "--probe"],
      "md",
      null,
      0,
    ),
    mcase(
      "err-show-probe-subagents",
      ["show", MAIN_ID, ...healthyBase(), "--probe", "--subagents"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--probe 只给规模摘要，与 --subagents 不能同时使用；去掉 --subagents，或去掉 --probe）\n",
      },
    ),
    mcase(
      "err-show-json-probe",
      ["show", MAIN_ID, ...healthyBase(), "--format", "json", "--probe"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（呈现类开关 --probe 仅 md 可用；去掉 --probe，或把 --format 改为 md）\n",
      },
    ),
  );
  // 问答：`--probe` 的问答数一行、以及"载荷结构不符即整体失败且不产出文件"。
  for (const id of [ASK_PAIRED_ID, ASK_UNPAIRED_ID, ASK_ERROR_ID]) {
    cases.push(
      mcase(`show-md-ask-probe-${id}`, ["show", id, ...healthyBase(), "--probe"], "md", null, 0),
      mcase(
        `show-md-ask-tools-${id}`,
        ["show", id, ...healthyBase(), "--tools", "--headers", "--truncate", "12"],
        "md",
        null,
        0,
      ),
    );
  }
  cases.push(
    mcase("err-show-ask-malformed", ["show", ASK_MALFORMED_ID, ...healthyBase()], "none", null, 3, {
      expectStderr: "错误: 数据不可读\n",
    }),
    mcase(
      "err-show-ask-malformed-tools",
      ["show", ASK_MALFORMED_ID, ...healthyBase(), "--tools"],
      "none",
      null,
      3,
      { expectStderr: "错误: 数据不可读\n" },
    ),
    // 规模探测会渲染一份完整副本，因此结构不符时探测同样整体失败（预计字节数不得建立在一份
    // 本来就不该产出的正文之上）。
    mcase(
      "err-show-ask-malformed-probe",
      ["show", ASK_MALFORMED_ID, ...healthyBase(), "--probe"],
      "none",
      null,
      3,
      { expectStderr: "错误: 数据不可读\n" },
    ),
    // `json`/`jsonl` 不做问答抽取，因此不受载荷结构影响：原始载荷照常导出。
    mcase(
      "show-ask-malformed-json",
      ["show", ASK_MALFORMED_ID, ...healthyBase(), "--format", "json"],
      "json",
      "show",
      0,
    ),
    mcase(
      "show-ask-malformed-jsonl",
      ["show", ASK_MALFORMED_ID, ...healthyBase(), "--format", "jsonl"],
      "jsonl",
      "jsonl",
      0,
    ),
  );
  cases.push(
    mcase(
      "show-md-grandchild-subagents",
      ["show", CHILD_ID, ...healthyBase(), "--subagents"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-explicit-format",
      ["show", MAIN_ID, ...healthyBase(), "--format", "md"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-main-subagents-headers",
      ["show", MAIN_ID, ...healthyBase(), "--subagents", "--headers"],
      "md",
      null,
      0,
    ),
    mcase("show-md-default-lib-anchor", ["show", MAIN_ID, "--dsh-home", "HEALTHY"], "md", null, 0),
    mcase(
      "show-md-truncate-1-header",
      ["show", MAIN_ID, ...healthyBase(), "--truncate", "1", "--headers"],
      "md",
      null,
      0,
    ),
  );
  for (let index = 0; index < 4; index += 1) {
    const args = ["show", MAIN_ID, ...healthyBase(), "--format", "json"];
    if (index % 2 === 0) args.push("--summary");
    if (index >= 2) args.push("--subagents");
    cases.push(mcase(`show-json-${index}`, args, "json", "show", 0));
  }
  cases.push(
    mcase(
      "show-jsonl-main",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl"],
      "jsonl",
      "jsonl",
      0,
    ),
    mcase(
      "show-jsonl-child",
      ["show", CHILD_ID, ...healthyBase(), "--format", "jsonl"],
      "jsonl",
      "jsonl",
      0,
    ),
    mcase(
      "err-show-json-thinking",
      ["show", MAIN_ID, ...healthyBase(), "--format", "json", "--thinking"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（呈现类开关 --thinking 仅 md 可用；去掉 --thinking，或把 --format 改为 md）\n",
      },
    ),
    mcase(
      "err-show-jsonl-summary",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl", "--summary"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--summary 不能与 --format jsonl 同时使用；去掉 --summary，或把 --format 改为 json）\n",
      },
    ),
    mcase(
      "err-show-jsonl-subagents",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl", "--subagents"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--subagents 不能与 --format jsonl 同时使用；去掉 --subagents，或把 --format 改为 json）\n",
      },
    ),
    mcase("err-show-missing-target", ["show", "zzzzzzzz", ...healthyBase()], "none", null, 1, {
      expectStderr: "错误: 目标不存在\n",
    }),
    mcase("err-show-short-prefix", ["show", "adv", ...healthyBase()], "none", null, 2, {
      expectStderr: "错误: 参数无效（会话前缀至少 8 个字符）\n",
    }),
    mcase(
      "err-show-ambiguous-prefix",
      ["show", "session-adv-", ...healthyBase()],
      "none",
      null,
      1,
      { expectStderr: `错误: 目标不存在（候选 ${HEALTHY_SESSION_COUNT} 个）\n` },
    ),
  );
  return cases;
}
