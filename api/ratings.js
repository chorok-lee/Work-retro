/* /api/ratings — 하루 평점 (1~5)
   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD  →  { ratings: [{ date, score }] }
   PUT  { date, score }                 →  그날 평점 저장 (score 0이면 삭제)

   DB는 NOTION_RATINGS_DB, 없으면 Integration이 볼 수 있는 DB 중 제목에
   '평점'(또는 rating)이 들어간 것을 찾아 씁니다. 하루에 한 행입니다. */

import { CFG, notion, queryAll, dbProps, findProp, requireToken, fail } from "./_notion.js";

let cached = null;
async function ratingsDb() {
  if (cached) return cached;
  let id = CFG.ratingsDb;
  if (!id) {
    const r = await notion("/search", {
      method: "POST",
      body: { query: "평점", filter: { value: "database", property: "object" }, page_size: 100 },
    });
    const title = (d) => (d.title || []).map((t) => t.plain_text).join("");
    const hit = (r.results || []).find((d) => /평점|rating/i.test(title(d)));
    if (!hit) {
      const e = new Error("하루 평점 DB를 찾지 못했습니다.");
      e.status = 404;
      e.hint = "노션에 '하루 평점' DB를 만들고 Integration을 연결하거나, NOTION_RATINGS_DB에 DB ID를 넣어주세요.";
      throw e;
    }
    id = hit.id;
  }
  const props = await dbProps(id);
  const used = new Set();
  const pTitle = findProp(props, ["이름", "Name"], "title", used);
  const pDate  = findProp(props, ["날짜", "Date"], "date", used);
  const pScore = findProp(props, ["점수", "평점", "Score"], "number", used);
  if (!pTitle || !pDate || !pScore) {
    const e = new Error("하루 평점 DB에서 '날짜'(date) 또는 '점수'(number) 속성을 찾지 못했습니다.");
    e.status = 500;
    throw e;
  }
  cached = { id, pTitle, pDate, pScore };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export default async function handler(req, res) {
  if (!requireToken(res)) return;

  try {
    const R = await ratingsDb();

    if (req.method === "GET") {
      const { from, to } = req.query || {};
      const filters = [];
      if (isDate(from)) filters.push({ property: R.pDate, date: { on_or_after: from } });
      if (isDate(to))   filters.push({ property: R.pDate, date: { on_or_before: to } });
      const rows = await queryAll(R.id, filters.length ? { filter: { and: filters } } : {});
      const ratings = rows
        .map((page) => ({
          date: page.properties?.[R.pDate]?.date?.start || "",
          score: page.properties?.[R.pScore]?.number || 0,
        }))
        .filter((r) => r.date && r.score > 0);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ratings });
    }

    if (req.method === "PUT") {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const score = Math.round(Number(b.score));
      if (!isDate(b.date) || !(score >= 0 && score <= 5)) {
        return res.status(400).json({ error: "date(YYYY-MM-DD)와 score(0~5)가 필요합니다." });
      }
      const rows = await queryAll(R.id, { filter: { property: R.pDate, date: { equals: b.date } } });
      /* 0점 = 지우기. 그 외엔 첫 행을 고치고, 혹시 중복된 행은 보관 */
      const [first, ...dups] = score ? rows : [null, ...rows];
      for (const row of dups) await notion(`/pages/${row.id}`, { method: "PATCH", body: { archived: true } });
      if (score) {
        const properties = {
          [R.pTitle]: { title: [{ text: { content: b.date } }] },
          [R.pDate]: { date: { start: b.date } },
          [R.pScore]: { number: score },
        };
        if (first) await notion(`/pages/${first.id}`, { method: "PATCH", body: { properties } });
        else await notion("/pages", { method: "POST", body: { parent: { database_id: R.id }, properties } });
      }
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: "GET, PUT만 지원합니다." });
  } catch (e) {
    fail(res, e);
  }
}
