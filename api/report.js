/* POST /api/report — 주간 리포트: 한 주의 레슨런 '해볼 것'을 테마로 묶고, 레슨런 전체(상황/문제 + 해볼 것)를 다시 읽어 인사이트를 줌
   { week: "10월 5주차", lessons: [{ date, problem, try }] }
   → { themes: [{ title, items: [해볼 것] }], insight: { headline, points: [문장] }, source: "ai" | "rules" }

   ANTHROPIC_API_KEY가 있으면 Claude로, 없거나 실패하면 규칙(주제 태그로 묶기)으로 만듭니다. 저장은 하지 않습니다. */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { reportByRules, stripBold } from "./_keywords.js";

const Report = z.object({
  themes: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
  insight: z.object({ headline: z.string(), points: z.array(z.string()) }),
});

const SYSTEM = `당신은 직장인의 주간 업무 회고를 돕는 코치입니다. 사용자는 한 주 동안 날마다 '상황/문제'와 다음에 바꿔 볼 '해볼 것'을 적었습니다.
할 일: 이번 주 레슨런을 읽고 주간 리포트를 만듭니다.
- themes: 해볼 것만 대상으로, 비슷한 것끼리 2~4개 테마로 묶습니다. title은 8자 안팎 명사구(예: "우선순위 먼저", "집중 시간 지키기"). items는 그 테마에 속한 해볼 것을 사용자의 말 그대로(필요하면 40자 안으로 다듬어) 넣습니다. 해볼 것이 하나뿐이면 테마 하나.
- insight: 이번 주 레슨런 전체(상황/문제와 해볼 것)를 다시 읽고 정리한 요약과 인사이트.
  - headline: 이번 주를 관통하는 패턴을 한 문장으로(해요체, 45자 안팎). 예: "급한 일이 끼어들 때 핵심 과업이 밀리는 한 주였어요"
  - points: 2~3개, 각 한두 문장(해요체, 80자 안팎). 다음 관점 중 근거가 있는 것만: 여러 날 반복된 상황/문제와 그 공통 원인, 해볼 것들이 공통으로 향하는 방향, 상황/문제는 있는데 해볼 것이 비어 있거나 겉도는 부분(놓치고 있는 것). 사용자가 쓴 표현을 짧게 인용해 근거를 보여 줍니다.
  - 지시형 "다음 주엔 ~하세요"로 끝내지 않습니다. 관찰과 해석을 줍니다.
  - 표면적인 개수 세기("n개 있어요")는 쓰지 않습니다. 왜 그런 일이 반복되는지, 상황/문제와 해볼 것 사이의 어긋남, 핵심 과업을 놓친 날과 그날 적은 상황의 연결처럼 사용자가 혼자서는 못 봤을 연결을 찾습니다. 함께 주는 '날짜별 핵심 과업'과 '루틴' 정보도 근거로 써도 됩니다.
- 한국어로, 사용자가 쓴 단어를 살려서 씁니다. 꾸밈말이나 칭찬은 넣지 않습니다.`;

async function reportByAI(week, lessons, ctx) {
  const client = new Anthropic();
  const lines = lessons.map((l, i) => `${i + 1}. [${l.date}] 상황/문제: ${l.problem || "(없음)"}\n   해볼 것: ${l.try || "(없음)"}`).join("\n");
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Report) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${week} 레슨런\n${lines}${ctxText(ctx)}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("리포트를 만들지 못했습니다.");
  const r = response.parsed_output;
  const themes = r.themes
    .map((t) => ({ title: t.title.trim().slice(0, 30), items: t.items.map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 6) }))
    .filter((t) => t.title && t.items.length)
    .slice(0, 4);
  const points = (r.insight?.points || []).map((x) => x.trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  if (!r.insight?.headline?.trim() || !points.length) throw new Error("리포트가 비었습니다.");
  return { themes, insight: { headline: r.insight.headline.trim().slice(0, 120), points } };
}

const ctxText = (ctx) => {
  const days = Object.entries(ctx?.coreByDay || {}).filter(([, v]) => v.total).map(([d, v]) => `${d} ${v.done}/${v.total}`);
  const rs = (ctx?.routines || []).map((r) => `${r.name}: 이번 주 ${r.cnt}/${r.target}회, 지난주 ${r.prev}회`);
  return (days.length ? `\n\n날짜별 핵심 과업(먹은/전체): ${days.join(", ")}` : "") + (rs.length ? `\n루틴: ${rs.join(" / ")}` : "");
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const s = (v, n) => String(v || "").trim().slice(0, n);
  const lessons = (Array.isArray(b.lessons) ? b.lessons : [])
    .map((l) => ({ date: s(l?.date, 10), problem: s(stripBold(l?.problem), 500), try: s(stripBold(l?.try), 1000) }))
    .filter((l) => l.problem || l.try)
    .slice(0, 40);
  /* 함께 보는 맥락: 날짜별 작은 개구리(핵심 과업) 결과, 루틴 이번 주/지난주 횟수 */
  const ctx = { coreByDay: {}, routines: [] };
  for (const [d, v] of Object.entries(b.ctx?.coreByDay || {}).slice(0, 7))
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) ctx.coreByDay[d] = { done: Number(v?.done) || 0, total: Number(v?.total) || 0 };
  ctx.routines = (Array.isArray(b.ctx?.routines) ? b.ctx.routines : []).slice(0, 12)
    .map((r) => ({ name: s(r?.name, 40), cnt: Number(r?.cnt) || 0, prev: Number(r?.prev) || 0, target: Number(r?.target) || 0 }));
  res.setHeader("Cache-Control", "no-store");
  if (!lessons.length) return res.status(200).json({ themes: [], insight: null, source: "rules" });

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return res.status(200).json({ ...(await reportByAI(s(b.week, 20), lessons, ctx)), source: "ai" });
    } catch (e) {
      console.error("report: AI 실패, 규칙으로 대신함", e?.status || "", e?.message || e);
    }
  }
  res.status(200).json({ ...reportByRules(lessons, ctx), source: "rules" });
}
