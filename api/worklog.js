/* POST /api/worklog — 이번 주 한 일: 끝낸 과업을 프로젝트·과제 단위로 묶음 (주간 회고 때 어떤 과제를 어떻게 진행했는지 보기)
   { week: "11월 1주차", tasks: [{ id, title, date }] }
   → { groups: [{ title, ids: [과업 id] }], source: "ai" | "rules" }

   ANTHROPIC_API_KEY가 있으면 Claude가 맥락으로 묶고(표기가 달라도 같은 과제면 하나로),
   없거나 실패하면 규칙(제목 앞쪽 낱말이 같은 것끼리)으로 묶습니다. 저장은 하지 않습니다. */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { groupTasksByRules, OTHER_WORK } from "./_keywords.js";

const Groups = z.object({
  groups: z.array(z.object({ title: z.string(), ids: z.array(z.string()) })),
});

const SYSTEM = `당신은 직장인의 주간 업무 회고를 돕습니다. 사용자가 이번 주에 끝낸 과업 목록을 줍니다(번호, 날짜, 제목).
할 일: 나중에 주간 회고에서 "어떤 프로젝트를 어떻게 진행했는지" 볼 수 있도록 과업을 프로젝트·과제 단위로 묶습니다.
- 표기가 달라도 같은 과제면 하나로 묶습니다(한글/영문 표기, 대소문자, 줄임말 — 예: "핸드사인"과 "Handsign", "마데"와 "마이데이터", "결.커."와 "결제커뮤니티").
- 제목에 과제 이름이 없어도 맥락(같은 사람에게 같은 건을 묻는 일, 앞 단계·다음 단계)으로 같은 과제라고 볼 수 있으면 함께 묶습니다. 확신이 없으면 묶지 않습니다.
- title: 사용자가 쓴 과제 이름을 살린 12자 안팎 명사구(예: "핸드사인", "마데 유도 선행 과제", "배송지 대시보드").
- 업무가 아닌 개인 일(경조사, 쇼핑, 가입, 개인 행정 등)은 "개인" 묶음 하나로.
- 어느 과제에도 속하지 않는 한 건짜리 업무는 "${OTHER_WORK}" 묶음 하나로 모읍니다.
- ids에는 과업 번호(문자열)를 넣습니다. 모든 번호가 정확히 한 묶음에 한 번씩 들어가야 합니다.
- 묶음 순서: 과업이 많은 과제부터.`;

async function groupByAI(week, tasks) {
  const client = new Anthropic();
  const lines = tasks.map((t, i) => `${i}. [${t.date}] ${t.title}`).join("\n");
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Groups) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${week} 끝낸 과업\n${lines}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("묶지 못했습니다.");
  /* 검증 — 모르는 번호는 버리고, 두 번 나온 번호는 처음 것만, 빠진 번호는 '그 밖의 일'로 */
  const seen = new Set();
  const groups = [];
  for (const g of response.parsed_output.groups) {
    const ids = g.ids.map((x) => tasks[Number(x)]?.id).filter((id) => id && !seen.has(id) && seen.add(id));
    const title = g.title.trim().slice(0, 30);
    if (ids.length && title) groups.push({ title, ids });
  }
  if (!groups.length) throw new Error("묶음이 비었습니다.");
  const missing = tasks.map((t) => t.id).filter((id) => !seen.has(id));
  if (missing.length) {
    const other = groups.find((g) => g.title === OTHER_WORK);
    if (other) other.ids.push(...missing); else groups.push({ title: OTHER_WORK, ids: missing });
  }
  return groups;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const s = (v, n) => String(v || "").trim().slice(0, n);
  const tasks = (Array.isArray(b.tasks) ? b.tasks : [])
    .map((t) => ({ id: s(t?.id, 64), title: s(t?.title, 200), date: s(t?.date, 10) }))
    .filter((t) => t.id && t.title)
    .slice(0, 80);
  res.setHeader("Cache-Control", "no-store");
  if (!tasks.length) return res.status(200).json({ groups: [], source: "rules" });

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return res.status(200).json({ groups: await groupByAI(s(b.week, 20), tasks), source: "ai" });
    } catch (e) {
      console.error("worklog: AI 실패, 규칙으로 대신함", e?.status || "", e?.message || e);
    }
  }
  res.status(200).json({ groups: groupTasksByRules(tasks), source: "rules" });
}
