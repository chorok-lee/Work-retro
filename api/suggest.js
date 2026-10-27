/* POST /api/suggest — 레슨런 '해볼 것' 자동완성 제안
   { problems: [상황/문제 문장], tries: [이미 적은 해볼 것] }
   → { suggestions: [{ problem: 상황/문제 순번, text: 해볼 것 }], source: "ai" | "rules" }

   이미 적은 해볼 것으로 이어지지 않은 상황/문제에만 제안합니다. 저장은 하지 않습니다(사용자가 고름).
   ANTHROPIC_API_KEY가 있으면 Claude로, 없거나 실패하면 규칙 기반으로 제안합니다. */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { suggestTriesByRules } from "./_keywords.js";

const Suggestions = z.object({
  suggestions: z.array(z.object({
    problem: z.number().int(),
    text: z.string(),
  })),
});

const SYSTEM = `당신은 직장인의 하루 업무 회고를 돕습니다. 사용자는 오늘 겪은 '상황/문제'와 다음에 바꿔 볼 '해볼 것'을 적습니다.
할 일: 이미 적은 해볼 것이 다루지 않는 상황/문제에 대해서만, 내일 바로 실천할 수 있는 해볼 것을 제안합니다.
- 상황/문제 하나에 제안은 최대 하나. 전체 최대 3개.
- 이미 적은 해볼 것과 뜻이 겹치면 제안하지 않습니다.
- 행동으로 옮길 수 없는 상황(단순한 사실, 감상)에는 제안하지 않습니다.
- 한국어 한 문장, 40자 안팎, "~하기"로 끝나는 구체적인 행동. 사용자의 상황에 쓰인 단어를 살려서 씁니다.
- problem에는 상황/문제 목록의 순번(0부터)을 넣습니다. 제안할 게 없으면 빈 배열.`;

async function suggestByAI(problems, tries) {
  const client = new Anthropic();
  const list = (arr) => arr.map((t, i) => `${i}. ${t}`).join("\n") || "(없음)";
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",                        // 안전 분류기가 거절하면 서버에서 다른 모델로 이어 받음
    output_config: { effort: "low", format: betaZodOutputFormat(Suggestions) },
    system: SYSTEM,
    messages: [{ role: "user", content: `상황/문제:\n${list(problems)}\n\n이미 적은 해볼 것:\n${list(tries)}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("제안을 만들지 못했습니다.");
  return response.parsed_output.suggestions
    .filter((s) => Number.isInteger(s.problem) && s.problem >= 0 && s.problem < problems.length && s.text.trim())
    .slice(0, 3)
    .map((s) => ({ problem: s.problem, text: s.text.trim().slice(0, 200) }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const clean = (arr) => (Array.isArray(arr) ? arr : []).map((t) => String(t || "").trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  const problems = clean(b.problems), tries = clean(b.tries);
  res.setHeader("Cache-Control", "no-store");
  if (!problems.length) return res.status(200).json({ suggestions: [], source: "rules" });

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return res.status(200).json({ suggestions: await suggestByAI(problems, tries), source: "ai" });
    } catch (e) {
      console.error("suggest: AI 실패, 규칙으로 대신함", e?.status || "", e?.message || e);
    }
  }
  res.status(200).json({ suggestions: suggestTriesByRules(problems, tries), source: "rules" });
}
