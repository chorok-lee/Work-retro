/* POST /api/report — 주간 리포트: 한 주의 레슨런 '해볼 것'을 묶어 테마와 다음 주에 집중할 하나를 뽑음
   { week: "10월 5주차", lessons: [{ date, problem, try }] }
   → { themes: [{ title, items: [해볼 것] }], focus: { text, why }, source: "ai" | "rules" }

   ANTHROPIC_API_KEY가 있으면 Claude로, 없거나 실패하면 규칙(주제 태그로 묶기)으로 만듭니다. 저장은 하지 않습니다. */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { reportByRules } from "./_keywords.js";

const Report = z.object({
  themes: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
  focus: z.object({ text: z.string(), why: z.string() }),
});

const SYSTEM = `당신은 직장인의 주간 업무 회고를 돕는 코치입니다. 사용자는 한 주 동안 날마다 '상황/문제'와 다음에 바꿔 볼 '해볼 것'을 적었습니다.
할 일: 이번 주 해볼 것들을 읽고 주간 리포트를 만듭니다.
- themes: 해볼 것을 비슷한 것끼리 2~4개 테마로 묶습니다. title은 8자 안팎 명사구(예: "우선순위 먼저", "집중 시간 지키기"). items는 그 테마에 속한 해볼 것을 사용자의 말 그대로(필요하면 40자 안으로 다듬어) 넣습니다. 해볼 것이 하나뿐이면 테마 하나.
- focus: 다음 주에 딱 하나만 실천한다면 무엇이 좋을지. text는 "~하기"로 끝나는 구체적인 행동 한 문장(40자 안팎), why는 이번 주 상황/문제에 근거한 이유 한 문장(해요체, 50자 안팎).
- 한국어로, 사용자가 쓴 단어를 살려서 씁니다. 꾸밈말이나 칭찬은 넣지 않습니다.`;

async function reportByAI(week, lessons) {
  const client = new Anthropic();
  const lines = lessons.map((l, i) => `${i + 1}. [${l.date}] 상황/문제: ${l.problem || "(없음)"}\n   해볼 것: ${l.try || "(없음)"}`).join("\n");
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 3000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Report) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${week} 레슨런\n${lines}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("리포트를 만들지 못했습니다.");
  const r = response.parsed_output;
  const themes = r.themes
    .map((t) => ({ title: t.title.trim().slice(0, 30), items: t.items.map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 6) }))
    .filter((t) => t.title && t.items.length)
    .slice(0, 4);
  if (!themes.length || !r.focus?.text?.trim()) throw new Error("리포트가 비었습니다.");
  return { themes, focus: { text: r.focus.text.trim().slice(0, 200), why: r.focus.why.trim().slice(0, 300) } };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const s = (v, n) => String(v || "").trim().slice(0, n);
  const lessons = (Array.isArray(b.lessons) ? b.lessons : [])
    .map((l) => ({ date: s(l?.date, 10), problem: s(l?.problem, 500), try: s(l?.try, 1000) }))
    .filter((l) => l.try)
    .slice(0, 40);
  res.setHeader("Cache-Control", "no-store");
  if (!lessons.length) return res.status(200).json({ themes: [], focus: null, source: "rules" });

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return res.status(200).json({ ...(await reportByAI(s(b.week, 20), lessons)), source: "ai" });
    } catch (e) {
      console.error("report: AI 실패, 규칙으로 대신함", e?.status || "", e?.message || e);
    }
  }
  res.status(200).json({ ...reportByRules(lessons), source: "rules" });
}
