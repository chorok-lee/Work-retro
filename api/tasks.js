/* /api/tasks — 오늘 할 일 (노션 과업 DB에서 마감일이 그날인 과업)
   GET    ?date=YYYY-MM-DD        →  { tasks: [{ id, title, done, priority, url }], tasksDb }
   POST   { title, date }         →  { task }   (마감일 = date 로 새 과업)
   PATCH  { id, done?, title? }   →  { ok }     (완료 체크·이름 수정)

   앱과 노션 어느 쪽에서 바꿔도 같은 DB 행을 고치므로, 다시 불러오면 맞춰집니다.
   우선순위가 '폐기'인 과업은 보여주지 않습니다. */

import { CFG, notion, queryAll, dbProps, byName, byType, readText, requireToken, fail } from "./_notion.js";

let cached = null;
async function taskProps() {
  if (cached) return cached;
  const props = await dbProps(CFG.tasksDb);
  const used = new Set();
  const pTitle    = byName(props, ["이름", "Name", "제목"], ["title"], used) || byType(props, ["title"], used);
  const pDue      = byName(props, ["마감일", "마감", "Due", "날짜", "Date"], ["date"], used) || byType(props, ["date"], used);
  const pDone     = byName(props, ["완료", "Done"], ["checkbox"], used) || byType(props, ["checkbox"], used);
  const pPriority = byName(props, ["우선순위", "Priority"], ["select", "status"], used);
  if (!pTitle || !pDue || !pDone) {
    const e = new Error("할 일 DB에서 이름(title)·마감일(date)·완료(checkbox) 속성을 찾지 못했습니다.");
    e.status = 500;
    e.hint = `현재 DB의 속성: ${Object.keys(props).join(", ")}`;
    throw e;
  }
  cached = { pTitle, pDue, pDone, pPriority };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const plain = (rich) => (rich || []).map((t) => t.plain_text).join("").trim();
const RANK = { 핵심: 0, 높음: 1, 보통: 2, 낮음: 3 };

const toTask = (P) => (page) => ({
  id: page.id,
  title: plain(page.properties?.[P.pTitle]?.title) || "(제목 없음)",
  done: !!page.properties?.[P.pDone]?.checkbox,
  priority: P.pPriority ? readText(page.properties?.[P.pPriority]) : "",
  url: page.url || "",
});

export default async function handler(req, res) {
  if (!requireToken(res)) return;

  try {
    const P = await taskProps();
    const b = req.body && typeof req.body === "object" ? req.body : {};

    if (req.method === "GET") {
      const { date } = req.query || {};
      if (!isDate(date)) return res.status(400).json({ error: "date(YYYY-MM-DD)가 필요합니다." });
      const rows = await queryAll(CFG.tasksDb, { filter: { property: P.pDue, date: { equals: date } } });
      const tasks = rows
        .map(toTask(P))
        .filter((t) => t.priority !== "폐기")
        .sort((a, z) => (a.done - z.done) || ((RANK[a.priority] ?? 4) - (RANK[z.priority] ?? 4)));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ tasks, tasksDb: CFG.tasksDb });
    }

    if (req.method === "POST") {
      const title = String(b.title || "").trim().slice(0, 200);
      if (!title || !isDate(b.date)) return res.status(400).json({ error: "title과 date(YYYY-MM-DD)가 필요합니다." });
      const page = await notion("/pages", {
        method: "POST",
        body: {
          parent: { database_id: CFG.tasksDb },
          properties: {
            [P.pTitle]: { title: [{ text: { content: title } }] },
            [P.pDue]: { date: { start: b.date } },
            [P.pDone]: { checkbox: false },
          },
        },
      });
      return res.status(200).json({ task: toTask(P)(page) });
    }

    if (req.method === "PATCH") {
      if (!b.id) return res.status(400).json({ error: "id가 필요합니다." });
      const properties = {};
      if (typeof b.done === "boolean") properties[P.pDone] = { checkbox: b.done };
      if (typeof b.title === "string" && b.title.trim()) properties[P.pTitle] = { title: [{ text: { content: b.title.trim().slice(0, 200) } }] };
      if (!Object.keys(properties).length) return res.status(400).json({ error: "바꿀 값(done 또는 title)이 없습니다." });
      await notion(`/pages/${b.id}`, { method: "PATCH", body: { properties } });
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: "GET, POST, PATCH만 지원합니다." });
  } catch (e) {
    fail(res, e);
  }
}
