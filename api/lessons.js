/* /api/lessons — 레슨런 (그날 배운 것 한 줄)
   한 단위 = 상황/문제(text, 노션 제목) + 해볼 것(try)
   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD  →  { lessons: [{ id, date, text, try, tags }] }
   POST   { date, items:[{problem, try}] } →  { items:[{ id, tags }] }   (단위마다 행 생성)
   PATCH  { id, text, try }               →  내용 수정
   DELETE { id }                          →  행 보관 처리

   DB는 NOTION_LESSONS_DB, 없으면 Integration이 볼 수 있는 DB 중 제목이
   '레슨런'(또는 lesson)인 것을 찾아 씁니다. */

import { CFG, notion, queryAll, dbProps, findProp, byName, requireToken, fail } from "./_notion.js";
import { extractTags } from "./_keywords.js";

let cached = null;
async function lessonsDb() {
  if (cached) return cached;
  let id = CFG.lessonsDb;
  if (!id) {
    const r = await notion("/search", {
      method: "POST",
      body: { query: "레슨", filter: { value: "database", property: "object" }, page_size: 100 },
    });
    const title = (d) => (d.title || []).map((t) => t.plain_text).join("");
    const hit = (r.results || []).find((d) => /레슨|lesson/i.test(title(d)));
    if (!hit) {
      const e = new Error("레슨런 DB를 찾지 못했습니다.");
      e.status = 404;
      e.hint = "노션에 '레슨런' DB를 만들고 Integration을 연결하거나, NOTION_LESSONS_DB에 DB ID를 넣어주세요.";
      throw e;
    }
    id = hit.id;
  }
  const props = await dbProps(id);
  const used = new Set();
  const pTitle = findProp(props, ["내용", "이름", "Name"], "title", used);
  const pDate  = findProp(props, ["날짜", "Date"], "date", used);
  if (!pTitle || !pDate) {
    const e = new Error("레슨런 DB에서 '내용'(title) 또는 '날짜'(date) 속성을 찾지 못했습니다.");
    e.status = 500;
    throw e;
  }
  /* 태그(다중 선택)는 있을 때만 씀 — 저장할 때 내용에서 키워드를 뽑아 자동으로 붙임 */
  const pTags = byName(props, ["태그", "Tags", "키워드"], ["multi_select"], used);
  /* 레슨런 한 단위 = 상황/문제(제목) + 해볼 것(텍스트). '해볼 것' 속성이 있을 때만 씀 */
  const pTry = byName(props, ["해볼 것", "해볼것", "Try"], ["rich_text"], used);
  cached = { id, pTitle, pDate, pTags, pTry };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const rich = (t) => [{ text: { content: t } }];
const plain = (rich) => (rich || []).map((t) => t.plain_text).join("").trim();

export default async function handler(req, res) {
  if (!requireToken(res)) return;

  try {
    const L = await lessonsDb();
    const b = req.body && typeof req.body === "object" ? req.body : {};

    if (req.method === "GET") {
      const { from, to } = req.query || {};
      const filters = [];
      if (isDate(from)) filters.push({ property: L.pDate, date: { on_or_after: from } });
      if (isDate(to))   filters.push({ property: L.pDate, date: { on_or_before: to } });
      const rows = await queryAll(L.id, {
        ...(filters.length ? { filter: { and: filters } } : {}),
        sorts: [{ property: L.pDate, direction: "descending" }, { timestamp: "created_time", direction: "descending" }],
      });
      const lessons = rows
        .map((page) => ({
          id: page.id,
          date: page.properties?.[L.pDate]?.date?.start || "",
          text: plain(page.properties?.[L.pTitle]?.title),
          tags: L.pTags ? (page.properties?.[L.pTags]?.multi_select || []).map((o) => o.name) : [],
          try: L.pTry ? plain(page.properties?.[L.pTry]?.rich_text) : "",
        }))
        .filter((l) => l.date && (l.text || l.try));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ lessons });
    }

    /* 저장: { date, items:[{ problem, try }] } — 한 단위(카드)마다 한 행. 예전 형태 { date, text }도 받음 */
    if (req.method === "POST") {
      const raw = Array.isArray(b.items) ? b.items : [{ problem: b.text }];
      const items = raw.map((it) => ({
        problem: String(it?.problem || "").trim().slice(0, 1000),
        try: String(it?.try || "").trim().slice(0, 1000),
      })).filter((it) => it.problem || it.try).slice(0, 30);
      if (!items.length || !isDate(b.date)) return res.status(400).json({ error: "items(또는 text)와 date(YYYY-MM-DD)가 필요합니다." });
      const saved = [];
      for (const it of items) {   // 노션 초당 호출 제한을 넘지 않도록 차례로
        const tags = extractTags(`${it.problem} ${it.try}`);
        const page = await notion("/pages", {
          method: "POST",
          body: {
            parent: { database_id: L.id },
            properties: {
              [L.pTitle]: { title: rich(it.problem) },
              [L.pDate]: { date: { start: b.date } },
              ...(L.pTags ? { [L.pTags]: { multi_select: tags.map((name) => ({ name })) } } : {}),
              ...(L.pTry ? { [L.pTry]: { rich_text: rich(it.try) } } : {}),
            },
          },
        });
        saved.push({ id: page.id, tags: L.pTags ? tags : [] });
      }
      return res.status(200).json({ items: saved, id: saved[0].id, tags: saved[0].tags });
    }

    if (req.method === "PATCH") {
      const text = String(b.text || "").trim().slice(0, 1000);
      const tryText = String(b.try || "").trim().slice(0, 1000);
      if (!b.id || !(text || tryText)) return res.status(400).json({ error: "id와 text(또는 try)가 필요합니다." });
      const tags = extractTags(`${text} ${tryText}`);
      await notion(`/pages/${b.id}`, {
        method: "PATCH",
        body: { properties: {
          [L.pTitle]: { title: rich(text) },
          ...(L.pTags ? { [L.pTags]: { multi_select: tags.map((name) => ({ name })) } } : {}),   // 고치면 태그도 다시 뽑음
          ...(L.pTry ? { [L.pTry]: { rich_text: rich(tryText) } } : {}),
        } },
      });
      return res.status(200).json({ ok: true, tags: L.pTags ? tags : [] });
    }

    if (req.method === "DELETE") {
      if (!b.id) return res.status(400).json({ error: "id가 필요합니다." });
      await notion(`/pages/${b.id}`, { method: "PATCH", body: { archived: true } });
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: "GET, POST, PATCH, DELETE만 지원합니다." });
  } catch (e) {
    fail(res, e);
  }
}
