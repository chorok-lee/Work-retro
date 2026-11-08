/* /api/weekly — 주간 회고 (한 주에 한 행)
   GET                           →  { retros: [retro…] }   (최근 주가 위, 최대 100개)
   GET ?week=YYYY-MM-DD(월요일)  →  { retro: { id, week, scores: {성과: 4, …}, notes: {성과: "…", …}, other, next } | null }
   PUT { week, scores, notes, other, next }  →  { retro }   (그 주 행이 있으면 고치고 없으면 만듦)

   DB는 NOTION_WEEKLY_DB, 없으면 Integration이 볼 수 있는 DB 중 제목에 '주간 회고'가 들어간 것을 찾아 씁니다.
   속성: 이름(title) · 주(date, 월~일) · 항목마다 점수(number)와 '<항목> 메모'(텍스트) · 그 외 · 다음 주 */

import { notion, queryAll, dbProps, findProp, byName, requireToken, fail } from "./_notion.js";
import { WEEKLY_ITEMS, splitBold } from "./_keywords.js";

let cached = null;
async function weeklyDb() {
  if (cached) return cached;
  let id = process.env.NOTION_WEEKLY_DB || "";
  if (!id) {
    const r = await notion("/search", {
      method: "POST",
      body: { query: "주간 회고", filter: { value: "database", property: "object" }, page_size: 100 },
    });
    const title = (d) => (d.title || []).map((t) => t.plain_text).join("");
    const hit = (r.results || []).find((d) => /주간\s*회고|weekly/i.test(title(d)));
    if (!hit) {
      const e = new Error("주간 회고 DB를 찾지 못했습니다.");
      e.status = 404;
      e.hint = "노션 '업무 회고' 페이지에 '주간 회고' DB를 만들고 Integration을 연결하거나, NOTION_WEEKLY_DB에 DB ID를 넣어주세요.";
      throw e;
    }
    id = hit.id;
  }
  const props = await dbProps(id);
  const used = new Set();
  const pTitle = findProp(props, ["이름", "Name"], "title", used);
  const pWeek = findProp(props, ["주", "날짜", "Week", "Date"], "date", used);
  if (!pTitle || !pWeek) {
    const e = new Error("주간 회고 DB에서 '이름'(title) 또는 '주'(date) 속성을 찾지 못했습니다.");
    e.status = 500;
    throw e;
  }
  const score = {}, note = {};
  for (const k of WEEKLY_ITEMS) {
    score[k] = byName(props, [k], ["number"], used);
    note[k] = byName(props, [`${k} 메모`], ["rich_text"], used);
  }
  const pOther = byName(props, ["그 외", "기타"], ["rich_text"], used);
  const pNext = byName(props, ["다음 주", "다음 주에 해볼 것"], ["rich_text"], used);
  cached = { id, pTitle, pWeek, score, note, pOther, pNext };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const addDays = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };
/* 그 주 이름 — 목요일이 속한 달 기준 'n월 n주차' (앱의 weekOfMonth와 같음) */
const weekLabel = (mon) => { const th = addDays(mon, 3); const [, m, d] = th.split("-").map(Number); return `${m}월 ${Math.ceil(d / 7)}주차`; };
/* **굵게** ↔ 노션 bold 주석 (레슨런과 같음). 노션 텍스트 조각은 2000자까지라 메모는 1000자로 자름 */
const rich = (t) => splitBold(String(t || "").slice(0, 1000)).map((s) => ({ text: { content: s.t }, ...(s.bold ? { annotations: { bold: true } } : {}) }));
const plain = (r) => (r || []).map((t) => (t.annotations?.bold && t.plain_text.trim() ? `**${t.plain_text}**` : t.plain_text)).join("").trim();
const toScore = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : null; };

const toRetro = (W) => (page) => {
  const p = page.properties || {};
  const scores = {}, notes = {};
  for (const k of WEEKLY_ITEMS) {
    scores[k] = W.score[k] ? toScore(p[W.score[k]]?.number) : null;
    notes[k] = W.note[k] ? plain(p[W.note[k]]?.rich_text) : "";
  }
  return {
    id: page.id, url: page.url || "", week: String(p[W.pWeek]?.date?.start || "").slice(0, 10), scores, notes,
    other: W.pOther ? plain(p[W.pOther]?.rich_text) : "",
    next: W.pNext ? plain(p[W.pNext]?.rich_text) : "",
  };
};

async function findWeek(W, week) {
  const rows = await queryAll(W.id, { filter: { property: W.pWeek, date: { equals: week } } });
  return rows[0] || null;
}

export default async function handler(req, res) {
  if (!requireToken(res)) return;
  try {
    const W = await weeklyDb();
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET") {
      const week = String(req.query?.week || "");
      /* week 없이 부르면 모든 주간 회고 — 최근 주가 위로 (회고 탭 목록) */
      if (!week) {
        const rows = await queryAll(W.id, { sorts: [{ property: W.pWeek, direction: "descending" }] });
        return res.status(200).json({ retros: rows.map(toRetro(W)).filter((r) => isDate(r.week)).slice(0, 100) });
      }
      if (!isDate(week)) return res.status(400).json({ error: "week(YYYY-MM-DD, 월요일)가 필요합니다." });
      const page = await findWeek(W, week);
      return res.status(200).json({ retro: page ? toRetro(W)(page) : null });
    }
    if (req.method === "PUT") {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const week = String(b.week || "");
      if (!isDate(week)) return res.status(400).json({ error: "week(YYYY-MM-DD, 월요일)가 필요합니다." });
      const properties = {
        [W.pTitle]: { title: [{ text: { content: weekLabel(week) } }] },
        [W.pWeek]: { date: { start: week, end: addDays(week, 6) } },
      };
      for (const k of WEEKLY_ITEMS) {
        if (W.score[k]) properties[W.score[k]] = { number: toScore(b.scores?.[k]) };
        if (W.note[k]) properties[W.note[k]] = { rich_text: rich(b.notes?.[k]) };
      }
      if (W.pOther) properties[W.pOther] = { rich_text: rich(b.other) };
      if (W.pNext) properties[W.pNext] = { rich_text: rich(b.next) };
      const found = await findWeek(W, week);
      const page = found
        ? await notion(`/pages/${found.id}`, { method: "PATCH", body: { properties } })
        : await notion("/pages", { method: "POST", body: { parent: { database_id: W.id }, properties } });
      return res.status(200).json({ retro: toRetro(W)(page) });
    }
    res.status(405).json({ error: "GET·PUT만 지원합니다." });
  } catch (e) {
    fail(res, e);
  }
}
