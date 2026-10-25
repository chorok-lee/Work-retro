/* GET /api/items
   →  { items: [{ id, name, kind, target, start }], itemsDb, ownerWarn }

   노션 항목 DB에서 '활성'이 켜진 항목을 가져옵니다.
   NOTION_OWNER가 설정되어 있으면 그 소유자의 항목만 돌려줍니다
   (기존 습관 DB를 그대로 연결해 쓰는 경우). */

import { CFG, queryAll, dbProps, byName, byType, readText, requireToken, fail } from "./_notion.js";

/* "매일" → 주 7회 / "주3회" → 주 3회 */
export function parseFreq(label) {
  const s = String(label || "").trim();
  if (/매일|daily/i.test(s)) return { kind: "daily", target: 7 };
  const m = s.match(/(\d+)\s*회/) || s.match(/^\s*(\d+)\s*$/);
  if (m) return { kind: "weekly", target: Math.max(1, Math.min(7, Number(m[1]))) };
  return { kind: "daily", target: 7 };
}

const plain = (rich) => (rich || []).map((t) => t.plain_text).join("").trim();

const OWNER_NAMES = ["소유자", "담당자", "주인", "사람", "Owner", "Person"];
const OWNER_TYPES = ["select", "status", "multi_select", "people", "rich_text", "formula"];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET만 지원합니다." });
  if (!requireToken(res)) return;

  try {
    const props = await dbProps(CFG.itemsDb);
    const used = new Set();

    /* 1단계 — 이름이 정확히 맞는 것부터 확정 */
    let pTitle = byName(props, ["이름", "Name", "제목", "항목"], ["title"], used);
    const pActive = byName(props, ["활성", "Active", "사용"], ["checkbox"], used)
                 || byType(props, ["checkbox"], used);
    let pFreq = byName(props, ["목표 빈도", "목표빈도", "빈도", "Frequency"], ["select"], used);
    const pStart = byName(props, ["시작일", "시작", "Start", "Start date"], ["date"], used);   // 없으면 페이지 생성일

    /* 소유자 필터는 NOTION_OWNER가 있을 때만 */
    let pOwner = null;
    if (CFG.owner) {
      const forced = process.env.NOTION_OWNER_PROP;
      pOwner = forced && props[forced] ? forced : byName(props, OWNER_NAMES, OWNER_TYPES, used);
    }

    /* 2단계 — 못 찾은 필수 항목만 타입으로 추측 */
    if (!pTitle) pTitle = byType(props, ["title"], used);
    if (!pFreq)  pFreq  = byType(props, ["select"], used);

    if (!pTitle) {
      return res.status(500).json({
        error: "항목 DB에서 제목(title) 속성을 찾지 못했습니다.",
        hint: `현재 DB의 속성: ${Object.keys(props).join(", ") || "(없음)"}`,
      });
    }

    const rows = await queryAll(CFG.itemsDb, {
      ...(pActive ? { filter: { property: pActive, checkbox: { equals: true } } } : {}),
    });

    let items = rows.map((page) => {
      const p = page.properties || {};
      return {
        id: page.id,
        name: plain(p[pTitle]?.title) || "(이름 없음)",
        owner: pOwner ? readText(p[pOwner]) : "",
        /* 회고에서 '시작 전'과 '못 한 주'를 구분하는 데 씁니다 */
        start: (pStart && p[pStart]?.date?.start) || page.created_time || "",
        ...parseFreq(pFreq ? p[pFreq]?.select?.name : ""),
      };
    });

    let ownerWarn = "";
    if (CFG.owner) {
      if (!pOwner) ownerWarn = `NOTION_OWNER가 설정됐지만 소유자 속성을 찾지 못해 모든 항목을 표시합니다. 현재 속성: ${Object.keys(props).join(", ")}`;
      else items = items.filter((it) => !it.owner || it.owner === CFG.owner);
    }
    items = items.map(({ owner, ...it }) => it);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items, itemsDb: CFG.itemsDb, ownerWarn });
  } catch (e) {
    fail(res, e);
  }
}
