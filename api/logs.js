/* /api/logs
   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD  →  { logs: [{ date, itemId }] }
   POST   { itemId, date }               →  체크 (행 생성)
   DELETE { itemId, date }               →  체크 해제 (행 보관 처리)

   규칙: Daily Logs에 행이 있으면 = 그날 그 항목 완료.
   노션 API에는 영구 삭제가 없어서 해제는 archived:true(보관)로 처리합니다. */

import { CFG, notion, queryAll, dbProps, findProp, requireToken, fail } from "./_notion.js";

let cached = null; // 속성 이름은 자주 안 바뀌므로 인스턴스 내에서 재사용
async function logProps() {
  if (cached) return cached;
  const props = await dbProps(CFG.logsDb);
  const used = new Set();
  const pDate     = findProp(props, ["날짜", "Date"], "date", used);
  const pRelation = findProp(props, ["항목", "Item", "습관", "Habit", "Habits"], "relation", used);
  if (!pDate || !pRelation) {
    const e = new Error("기록 DB에서 '날짜'(date) 또는 '항목'(relation) 속성을 찾지 못했습니다.");
    e.status = 500;
    throw e;
  }
  cached = { pDate, pRelation };
  return cached;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/* 같은 날짜 + 같은 항목의 기존 행 찾기 */
async function findRows({ pDate, pRelation }, itemId, date) {
  const rows = await queryAll(CFG.logsDb, {
    filter: {
      and: [
        { property: pDate, date: { equals: date } },
        { property: pRelation, relation: { contains: itemId } },
      ],
    },
  });
  return rows;
}

function readBody(req) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const q = req.query || {};
  return { itemId: b.itemId || q.itemId, date: b.date || q.date };
}

export default async function handler(req, res) {
  if (!requireToken(res)) return;

  try {
    const P = await logProps();

    /* ── 조회 ── */
    if (req.method === "GET") {
      const { from, to } = req.query || {};
      const filters = [];
      if (isDate(from)) filters.push({ property: P.pDate, date: { on_or_after: from } });
      if (isDate(to))   filters.push({ property: P.pDate, date: { on_or_before: to } });

      const rows = await queryAll(CFG.logsDb, filters.length ? { filter: { and: filters } } : {});
      const logs = rows
        .map((page) => {
          const p = page.properties || {};
          return {
            date: p[P.pDate]?.date?.start || "",
            itemId: p[P.pRelation]?.relation?.[0]?.id || "",
          };
        })
        .filter((r) => r.date && r.itemId);

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ logs });
    }

    const { itemId, date } = readBody(req);
    if (!itemId || !isDate(date)) {
      return res.status(400).json({ error: "itemId와 date(YYYY-MM-DD)가 필요합니다." });
    }

    /* ── 체크: 행 생성 (중복 방지) ── */
    if (req.method === "POST") {
      const existing = await findRows(P, itemId, date);
      if (existing.length) return res.status(200).json({ ok: true, already: true });

      await notion("/pages", {
        method: "POST",
        body: {
          parent: { database_id: CFG.logsDb },
          properties: {
            [P.pDate]: { date: { start: date } },
            [P.pRelation]: { relation: [{ id: itemId }] },
          },
        },
      });
      return res.status(200).json({ ok: true, created: true });
    }

    /* ── 해제: 행 보관 처리 ── */
    if (req.method === "DELETE") {
      const rows = await findRows(P, itemId, date);
      for (const row of rows) {
        await notion(`/pages/${row.id}`, { method: "PATCH", body: { archived: true } });
      }
      return res.status(200).json({ ok: true, archived: rows.length });
    }

    res.status(405).json({ error: "GET, POST, DELETE만 지원합니다." });
  } catch (e) {
    fail(res, e);
  }
}
