/* /api/lessons — 레슨런 (그날 배운 것 한 줄)
   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD  →  { lessons: [{ id, date, text }] }
   POST   { date, text }                  →  { id }   (행 생성)
   PATCH  { id, text }                    →  내용 수정
   DELETE { id }                          →  행 보관 처리

   DB는 NOTION_LESSONS_DB, 없으면 Integration이 볼 수 있는 DB 중 제목이
   '레슨런'(또는 lesson)인 것을 찾아 씁니다. */

import { CFG, notion, queryAll, dbProps, findProp, requireToken, fail } from "./_notion.js";

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
  cached = { id, pTitle, pDate };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
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
        }))
        .filter((l) => l.date && l.text);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ lessons });
    }

    if (req.method === "POST") {
      const text = String(b.text || "").trim().slice(0, 500);
      if (!text || !isDate(b.date)) return res.status(400).json({ error: "text와 date(YYYY-MM-DD)가 필요합니다." });
      const page = await notion("/pages", {
        method: "POST",
        body: {
          parent: { database_id: L.id },
          properties: {
            [L.pTitle]: { title: [{ text: { content: text } }] },
            [L.pDate]: { date: { start: b.date } },
          },
        },
      });
      return res.status(200).json({ id: page.id });
    }

    if (req.method === "PATCH") {
      const text = String(b.text || "").trim().slice(0, 500);
      if (!b.id || !text) return res.status(400).json({ error: "id와 text가 필요합니다." });
      await notion(`/pages/${b.id}`, {
        method: "PATCH",
        body: { properties: { [L.pTitle]: { title: [{ text: { content: text } }] } } },
      });
      return res.status(200).json({ ok: true });
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
