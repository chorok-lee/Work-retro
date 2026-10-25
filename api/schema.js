/* GET /api/schema
   노션 DB가 실제로 어떤 속성을 갖고 있는지 보여주는 진단용 주소입니다.
   연동이 안 될 때 https://(내주소)/api/schema 를 열어 확인하세요. */

import { CFG, dbProps, requireToken, fail } from "./_notion.js";

const summarize = (props) =>
  Object.entries(props).map(([name, v]) => ({
    name,
    type: v.type,
    ...(["select", "status", "multi_select"].includes(v.type)
      ? { options: (v[v.type]?.options || []).map((o) => o.name) }
      : {}),
  }));

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET만 지원합니다." });
  if (!requireToken(res)) return;

  try {
    const [items, logs] = await Promise.all([dbProps(CFG.itemsDb), dbProps(CFG.logsDb)]);
    let 할일DB;
    try { 할일DB = { id: CFG.tasksDb, 속성: summarize(await dbProps(CFG.tasksDb)) }; }
    catch (e) { 할일DB = { id: CFG.tasksDb, 상태: "접근 실패: " + e.message + " — 이 DB의 ··· → Connections에 Integration을 추가해주세요" }; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      항목DB: { id: CFG.itemsDb, 속성: summarize(items) },
      기록DB: { id: CFG.logsDb, 속성: summarize(logs) },
      할일DB,
      레슨런DB: CFG.lessonsDb || "(미설정 → 제목 '레슨런'으로 자동 탐색)",
      설정: {
        NOTION_OWNER: CFG.owner || "(미설정 → 모든 항목 표시)",
        NOTION_OWNER_PROP: process.env.NOTION_OWNER_PROP || "(미설정 → 자동 탐색)",
      },
    });
  } catch (e) {
    fail(res, e);
  }
}
