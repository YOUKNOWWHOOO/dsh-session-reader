// 用途：全组合 lint 门禁的查询与校验类组合定义（search / stats / check 的命令×参数枚举与边界补充）。
// 主要入口：searchCases、statsCases、checkCases（返回逐组合用例）。
// 关键依赖：./matrix-cases.ts（mcase/healthyBase 与组合词汇）、./matrix-fixtures.ts（夹具会话 id）、
//           ./matrix-paths.ts（官方库锚点）。
// 设计约束：组合只增不减；错误路径必须给定期望退出码与 stderr 全文（含候选数形态），
//           损坏夹具（BROKEN）与真实会话的容错声明必须逐条断言，禁止放宽为"允许失败"。

import { healthyBase, type MatrixCase, mcase, ORIGINS } from "./matrix-cases.ts";
import { CHILD_ID, MAIN_ID } from "./matrix-fixtures.ts";
import { libRoot } from "./matrix-paths.ts";

/** search 组合：关键词×作用域×大小写×来源交叉 + 位置参数边界 + 会话限定/反选 + 错误路径。 */
export function searchCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const keywords = ["needle", "example.com", "<script>", "$ echo", "zzznomatch"] as const;
  const scopes = ["text", "tools", "all"] as const;
  for (let index = 0; index < 12; index += 1) {
    const args = ["search", keywords[index % 5], ...healthyBase()];
    args.push("--scope", scopes[index % 3]);
    if (index % 2 === 1) args.push("--case-sensitive");
    const origin = ORIGINS[index % 3];
    if (origin !== "all") args.push("--origin", origin);
    args.push("--context", String([0, 60][index % 2]));
    args.push("--limit", String([0, 1][index % 2]));
    cases.push(mcase(`search-md-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase(
      "search-md-workspace-filter",
      ["search", "needle", ...healthyBase(), "--workspace", "user_projects"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-since-filter",
      ["search", "needle", ...healthyBase(), "--since", "0", "--until", "9999999999999"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-zero-hit",
      ["search", "zzznomatch", ...healthyBase(), "--scope", "all"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-case-sensitive-zero",
      ["search", "NEEDLE", ...healthyBase(), "--case-sensitive"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-dash-keyword",
      ["search", "--scope", "all", ...healthyBase(), "--", "- item"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-dash-keyword-context",
      ["search", "--context", "0", ...healthyBase(), "--", "--fix"],
      "md",
      null,
      0,
    ),
  );
  for (let index = 0; index < 4; index += 1) {
    const args = [
      "search",
      ["needle", "example.com"][index % 2],
      ...healthyBase(),
      "--format",
      "json",
    ];
    args.push("--scope", scopes[index % 3], "--limit", ["1", "0"][index % 2]);
    cases.push(mcase(`search-json-${index}`, args, "json", "search", 0));
  }
  // --session 限定：主会话自身与子树、子代理自身、前缀形态、以及无匹配路径。
  cases.push(
    mcase(
      "search-md-session-main",
      ["search", "needle", ...healthyBase(), "--scope", "all", "--session", MAIN_ID],
      "md",
      null,
      0,
    ),
    // --exclude-session：反选整棵子树（剔除调用方自己的语料）。
    mcase(
      "search-md-exclude-main",
      ["search", "needle", ...healthyBase(), "--scope", "all", "--exclude-session", MAIN_ID],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-exclude-child",
      ["search", "needle", ...healthyBase(), "--exclude-session", CHILD_ID],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-exclude-and-session",
      [
        "search",
        "needle",
        ...healthyBase(),
        "--scope",
        "all",
        "--session",
        MAIN_ID,
        "--exclude-session",
        CHILD_ID,
      ],
      "md",
      null,
      0,
    ),
    mcase(
      "search-json-exclude",
      ["search", "needle", ...healthyBase(), "--exclude-session", MAIN_ID, "--format", "json"],
      "json",
      "search",
      0,
    ),
    mcase(
      "err-search-exclude-unknown",
      ["search", "needle", ...healthyBase(), "--exclude-session", "zzzzzzzz"],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "err-search-exclude-short-prefix",
      ["search", "needle", ...healthyBase(), "--exclude-session", "adv"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（会话前缀至少 8 个字符）\n" },
    ),
    mcase(
      "search-md-session-child",
      ["search", "needle", ...healthyBase(), "--scope", "all", "--session", CHILD_ID],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-prefix",
      ["search", "needle", ...healthyBase(), "--session", "adv-main"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-last",
      ["search", "needle", ...healthyBase(), "--session", "last"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-with-workspace",
      [
        "search",
        "needle",
        ...healthyBase(),
        "--session",
        MAIN_ID,
        "--workspace",
        "user_projects",
        "--since",
        "0",
      ],
      "md",
      null,
      0,
    ),
    mcase(
      "search-json-session",
      ["search", "needle", ...healthyBase(), "--session", MAIN_ID, "--format", "json"],
      "json",
      "search",
      0,
    ),
    mcase(
      "err-search-session-unknown",
      ["search", "needle", ...healthyBase(), "--session", "zzzzzzzz"],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "err-search-session-short-prefix",
      ["search", "needle", ...healthyBase(), "--session", "adv"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（会话前缀至少 8 个字符）\n" },
    ),
  );
  cases.push(
    mcase("err-search-missing-keyword", ["search", ...healthyBase()], "none", null, 2, {
      expectStderr: "错误: 参数无效（缺少位置参数: <关键词>）\n",
    }),
    mcase(
      "err-search-bad-scope",
      ["search", "needle", ...healthyBase(), "--scope", "bad"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（选项值无效: --scope）\n" },
    ),
    mcase(
      "err-search-dash-without-terminator",
      ["search", "- item", ...healthyBase()],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（未知选项: - item）\n" },
    ),
    mcase(
      "err-search-unknown-target",
      ["search", "needle", "--dsh-home", "NO_SUCH_HOME", "--lib-root", libRoot()],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
  );
  return cases;
}

/** stats 组合：全局聚合（含来源枚举与零命中）+ 单会话统计 + json 形态 + 范围过滤拒绝路径。 */
export function statsCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (let index = 0; index < 3; index += 1) {
    cases.push(
      mcase(
        `stats-md-global-${index}`,
        ["stats", ...healthyBase(), "--origin", ORIGINS[index]],
        "md",
        null,
        0,
      ),
    );
  }
  cases.push(
    mcase(
      "stats-md-global-workspace",
      ["stats", ...healthyBase(), "--workspace", "user_projects"],
      "md",
      null,
      0,
    ),
    mcase(
      "stats-md-global-zero",
      ["stats", ...healthyBase(), "--since", "9999999999999"],
      "md",
      null,
      0,
    ),
    mcase("stats-md-single-main", ["stats", MAIN_ID, ...healthyBase()], "md", null, 0),
    mcase("stats-md-single-child", ["stats", CHILD_ID, ...healthyBase()], "md", null, 0),
    mcase("stats-md-single-prefix", ["stats", "adv-main", ...healthyBase()], "md", null, 0),
    mcase(
      "stats-md-single-nopc",
      ["stats", "session-adv-nopc-10", ...healthyBase()],
      "md",
      null,
      0,
    ),
    mcase(
      "stats-md-single-pcpart",
      ["stats", "session-adv-pcpart-13", ...healthyBase()],
      "md",
      null,
      0,
    ),
  );
  cases.push(
    mcase("stats-json-global", ["stats", ...healthyBase(), "--format", "json"], "json", "stats", 0),
    mcase(
      "stats-json-global-origin",
      ["stats", ...healthyBase(), "--origin", "subagent", "--format", "json"],
      "json",
      "stats",
      0,
    ),
    mcase(
      "stats-json-single",
      ["stats", MAIN_ID, ...healthyBase(), "--format", "json"],
      "json",
      "stats",
      0,
    ),
    mcase(
      "stats-json-single-pcver",
      ["stats", "session-adv-pcver-11", ...healthyBase(), "--format", "json"],
      "json",
      "stats",
      0,
    ),
  );
  cases.push(
    mcase("err-stats-unknown-target", ["stats", "zzzzzzzz", ...healthyBase()], "none", null, 1, {
      expectStderr: "错误: 目标不存在\n",
    }),
    mcase(
      "err-stats-single-filter-since",
      ["stats", MAIN_ID, ...healthyBase(), "--since", "0"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --since；去掉 --since，或去掉会话目标改用全局聚合）\n",
      },
    ),
    mcase(
      "err-stats-single-filter-origin",
      ["stats", MAIN_ID, ...healthyBase(), "--origin", "main"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --origin；去掉 --origin，或去掉会话目标改用全局聚合）\n",
      },
    ),
    mcase(
      "err-stats-single-filter-workspace",
      ["stats", MAIN_ID, ...healthyBase(), "--workspace", "user_projects"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --workspace；去掉 --workspace，或去掉会话目标改用全局聚合）\n",
      },
    ),
  );
  return cases;
}

/** check 组合：健康/损坏两套夹具 + 断裂会话容错 + "数据不可读"与"目标不存在"的分类边界。 */
export function checkCases(): MatrixCase[] {
  return [
    mcase("check-md-healthy", ["check", ...healthyBase()], "md", null, 0),
    mcase("check-md-single-main", ["check", MAIN_ID, ...healthyBase()], "md", null, 0),
    mcase(
      "check-md-single-nopc",
      ["check", "session-adv-nopc-10", ...healthyBase()],
      "md",
      null,
      0,
    ),
    mcase(
      "check-md-broken",
      ["check", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "md",
      null,
      3,
    ),
    mcase(
      "check-md-broken-torn",
      ["check", "session-brk-torn-14", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "md",
      null,
      3,
    ),
    mcase(
      "check-json-broken",
      ["check", "--dsh-home", "BROKEN", "--lib-root", libRoot(), "--format", "json"],
      "json",
      "check",
      3,
    ),
    mcase(
      "show-md-broken-torn",
      ["show", "session-brk-torn-14", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "md",
      null,
      0,
    ),
    mcase(
      "err-show-broken-gap",
      ["show", "session-brk-gap-15", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "none",
      null,
      3,
      { expectStderr: "错误: 数据不可读\n" },
    ),
    mcase(
      "err-show-broken-corrupt",
      ["show", "session-brk-corrupt-16", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "none",
      null,
      3,
      // P7 根因修复：会话目录存在于磁盘上、只是 header 不可读，必须与"确实不存在"可区分
      // （后者退出 1）。二者此前都落到"目标不存在"，使全量扫描误判为漏读。
      { expectStderr: "错误: 数据不可读\n" },
    ),
    mcase(
      "err-show-broken-corrupt-unknown",
      ["show", "session-brk-zzzz", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "list-md-broken-tolerant",
      ["list", "--dsh-home", "BROKEN", "--lib-root", libRoot()],
      "md",
      null,
      0,
    ),
  ];
}
