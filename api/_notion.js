/* ────────────────────────────────────────────────────────────
   노션 API 공용 모듈 (서버 전용)
   - 이 파일은 Vercel 서버에서만 실행됩니다. 브라우저로 내려가지 않아요.
   - 파일명이 _로 시작하면 Vercel이 주소로 노출하지 않습니다.
──────────────────────────────────────────────────────────── */

const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1";

/* 환경변수는 요청 시점에 읽습니다 (배포 후 값을 바꿔도 바로 반영) */
export const CFG = {
  get token()   { return process.env.NOTION_TOKEN; },
  get itemsDb() { return process.env.NOTION_ITEMS_DB || ""; },
  get logsDb()  { return process.env.NOTION_LOGS_DB  || ""; },
  get owner()   { return process.env.NOTION_OWNER    || ""; },
  get lessonsDb(){ return process.env.NOTION_LESSONS_DB || ""; },
};

/* 토큰·DB ID가 없으면 여기서 안내와 함께 끝냄 */
export function requireToken(res) {
  const missing = [
    !CFG.token && "NOTION_TOKEN",
    !CFG.itemsDb && "NOTION_ITEMS_DB",
    !CFG.logsDb && "NOTION_LOGS_DB",
  ].filter(Boolean);
  if (missing.length) {
    res.status(503).json({
      error: `노션 설정이 비어 있습니다: ${missing.join(", ")}`,
      hint: `Vercel 프로젝트 → Settings → Environment Variables에 ${missing.join(", ")}을(를) 추가하고 다시 배포해주세요.`,
    });
    return false;
  }
  return true;
}

export async function notion(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CFG.token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* 본문 없는 응답 */ }
  if (!r.ok) {
    const err = new Error(data?.message || `노션 API 오류 (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return data;
}

/* 페이지네이션까지 끝까지 가져오기 (노션은 한 번에 최대 100건) */
export async function queryAll(dbId, body = {}) {
  const out = [];
  let cursor;
  do {
    const page = await notion(`/databases/${dbId}/query`, {
      method: "POST",
      body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

export async function dbProps(dbId) {
  const db = await notion(`/databases/${dbId}`);
  return db.properties || {};
}

/* 속성 찾기: ①이름이 정확히 맞고 타입도 맞으면 그것 ②없으면 타입이 맞는 첫 속성
   (노션에서 컬럼 이름을 조금 바꿔도 동작하도록) */
export function findProp(props, names, type, used = new Set()) {
  for (const n of names) {
    if (props[n]?.type === type && !used.has(n)) { used.add(n); return n; }
  }
  for (const [k, v] of Object.entries(props)) {
    if (v.type === type && !used.has(k)) { used.add(k); return k; }
  }
  return null;
}

/* 이름으로만 찾기 (타입 추측 없음) — 이름 매칭을 전부 끝낸 뒤 타입 추측을 해야
   '색상'을 못 찾아서 '담당자'를 색상으로 집어가는 식의 오인식이 생기지 않습니다. */
export function byName(props, names, types, used = new Set()) {
  for (const n of names) {
    if (props[n] && types.includes(props[n].type) && !used.has(n)) { used.add(n); return n; }
  }
  return null;
}

/* 타입으로만 찾기 (아직 아무도 안 쓴 속성 중 첫 번째) */
export function byType(props, types, used = new Set()) {
  for (const [k, v] of Object.entries(props)) {
    if (types.includes(v.type) && !used.has(k)) { used.add(k); return k; }
  }
  return null;
}

/* 속성 값을 타입에 상관없이 문자열로 읽기 */
export function readText(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "select":       return prop.select?.name || "";
    case "status":       return prop.status?.name || "";
    case "multi_select": return prop.multi_select?.[0]?.name || "";
    case "people":       return prop.people?.[0]?.name || "";
    case "rich_text":    return (prop.rich_text || []).map((t) => t.plain_text).join("").trim();
    case "title":        return (prop.title || []).map((t) => t.plain_text).join("").trim();
    case "formula":      return String(prop.formula?.string || prop.formula?.number || "");
    default:             return "";
  }
}

/* 오류를 사용자가 읽고 조치할 수 있는 문장으로 바꿔 응답 */
export function fail(res, e) {
  const status = e.status || 500;
  const hints = {
    401: "노션 토큰이 올바르지 않습니다. Vercel의 NOTION_TOKEN 값을 다시 확인해주세요.",
    403: "이 토큰으로는 해당 데이터베이스에 접근할 수 없습니다. 노션 DB 우상단 ··· → Connections에서 Integration을 연결해주세요.",
    404: "데이터베이스를 찾을 수 없습니다. 노션 DB의 ··· → Connections에 Integration이 연결되어 있는지, DB ID가 맞는지 확인해주세요.",
    429: "노션 요청이 잠시 몰렸습니다. 몇 초 뒤 다시 시도해주세요.",
  };
  res.status(status).json({ error: e.message, hint: e.hint || hints[status] || "" });
}
