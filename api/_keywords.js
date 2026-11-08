/* 레슨런 자동 태그 — 문장에서 업무 주제를 찾아 태그로 (서버·앱 공용)
   1순위: 아래 주제 사전에 걸리는 것 (등장 순서대로 최대 3개)
   2순위: 하나도 안 걸리면 문장에서 명사처럼 보이는 낱말 최대 2개
   노션 다중 선택은 처음 보는 이름을 주면 선택지를 새로 만듭니다. */

const THEMES = [
  ["회의", /회의|미팅|안건|원온원|1on1|1:1|스탠드업|싱크/i],
  ["소통", /소통|공유|커뮤니케이션|설명|전달|질문|대화|슬랙|메일|보고|연락/],
  ["우선순위", /우선순위|중요한|급한|먼저|순서|쪼개|나눠|덜어|버리/],
  ["집중", /집중|딥워크|몰입|방해|알림|멀티태스킹|산만|끊기/],
  ["일정", /일정|마감|데드라인|시간|오전|오후|아침|퇴근|캘린더|지연|늦어|미뤄/],
  ["피드백", /피드백|리뷰|검토|코멘트|의견|회고/],
  ["협업", /협업|같이|함께|동료|팀원|팀|협의|조율|요청/],
  ["문서", /문서|기록|정리|작성|노트|위키|스펙|기획서|보고서/],
  ["학습", /학습|공부|배우|배운|아티클|책|강의|스터디/],
  ["컨디션", /수면|취침|기상|늦잠|컨디션|피곤|운동|잠을|자서/],
];
/* 주제 사전에 걸리는 첫 주제 (없으면 null) */
const themeOf = (text) => {
  const s = String(text || "");
  const hits = THEMES.map(([tag, re]) => ({ tag, at: s.search(re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return hits[0]?.tag || null;
};

const JOSA = ["에서는", "으로는", "에게서", "까지는", "이라는", "에서도", "에게는", "에서", "에게", "으로", "까지", "부터",
  "보다", "처럼", "하고", "이랑", "라는", "은", "는", "이", "가", "을", "를", "에", "의", "로", "와", "과", "도", "만", "랑"];
const STOP = new Set(["오늘", "내일", "어제", "이번", "다음", "지난", "정말", "너무", "조금", "그리고", "하지만", "그래서", "그냥",
  "다시", "먼저", "계속", "항상", "매번", "가장", "모두", "전부", "우리", "나는", "내가", "이것", "그것", "때문", "경우", "정도"]);

const strip = (w) => {
  for (const j of JOSA) if (w.length > j.length + 1 && w.endsWith(j)) return w.slice(0, -j.length);
  return w;
};

export function extractTags(text) {
  const s = String(text || "");
  const hits = THEMES.map(([tag, re]) => ({ tag, at: s.search(re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  if (hits.length) return hits.slice(0, 3).map((h) => h.tag);

  const words = [];
  for (const raw of s.split(/[^0-9A-Za-z가-힣]+/)) {
    const w = strip(raw);
    if (w.length < 2 || w.length > 8 || STOP.has(w)) continue;
    if (/[다요고서면게지며니네죠]$/.test(w)) continue;   // 동사·형용사 활용형은 건너뜀
    if (!words.includes(w)) words.push(w);
    if (words.length === 2) break;
  }
  return words;
}

/* ── 레슨런 입력 도우미 ── */

/* 붙여넣은 여러 줄 → 줄마다 하나 ("- ", "• ", "1. " 같은 불릿은 떼고, 빈 줄은 버림) */
export function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/* 규칙 기반 '해볼 것' 제안 — AI(ANTHROPIC_API_KEY)가 없거나 실패할 때 쓰는 대비책.
   상황/문제 문장에 걸리는 패턴마다 해볼 것 하나. 이미 적은 해볼 것과 주제가 겹치면 건너뜀. */
const TRY_RULES = [
  [/늦잠|늦게\s*자|수면|잠을|스마트폰|폰\s*하느라|컨디션/, "자기 1시간 전에 스마트폰을 멀리 두고 잘 시간 정해 두기"],
  [/집중|산만|방해|딴짓|멍/, "오전 첫 2시간은 알림을 끄고 가장 중요한 일 하나만 하기"],
  [/우선순위|중요한\s*(?:업무|일)|뭘\s*해야|모호/, "하루를 시작하기 전에 오늘 꼭 끝낼 일 1개를 먼저 정하기"],
  [/기준|결과물|예상\s*안|범위|스코프/, "계획할 때 결과물과 완료 기준을 한 줄로 적고 걸릴 시간 어림하기"],
  [/기획서|업데이트\s*안|공유\s*안|정보가\s*없|누락|빠져/, "필요한 정보가 비어 있으면 작업 전에 담당자에게 바로 요청하기"],
  [/회의|미팅|안건/, "회의 전날 안건과 결정할 것을 미리 공유하기"],
  [/비효율|두\s*번|2번|다시\s*하|재작업/, "시작 전에 요구사항을 한 번 더 확인해 다시 하는 일 줄이기"],
  [/시간\s*(?:날|낭비)|날려|지연|밀렸|늦어/, "막히면 30분 안에 도움을 요청하거나 다른 일로 넘어가기"],
  [/리뷰|피드백|검토/, "리뷰 요청은 오전에 보내고 받을 시점을 함께 적기"],
  [/티타임|잡담|코어\s*타임/, "코어 타임에는 짧은 휴식만 두고 긴 대화는 오후 늦게로 옮기기"],
];

export function suggestTriesByRules(problems, tries) {
  const tryTags = new Set((tries || []).flatMap((t) => extractTags(t)));
  const out = [];
  (problems || []).forEach((p, i) => {
    const pTags = extractTags(p);
    if (pTags.some((t) => tryTags.has(t))) return;          // 이미 같은 주제의 해볼 것이 있음
    const rule = TRY_RULES.find(([re]) => re.test(p));
    if (!rule || out.some((s) => s.text === rule[1])) return;
    if (extractTags(rule[1]).some((t) => tryTags.has(t))) return;   // 제안 자체가 이미 적은 해볼 것과 같은 주제
    out.push({ problem: i, text: rule[1] });
  });
  return out.slice(0, 3);
}

/* 규칙 기반 주간 리포트 — AI가 없거나 실패할 때. 해볼 것을 줄(불릿)마다 나눠 첫 주제 태그로 묶음 */
const THEME_TITLE = { 회의: "회의 준비", 소통: "소통·공유", 우선순위: "우선순위 먼저", 집중: "집중 시간", 일정: "시간·일정",
  피드백: "검토·피드백", 협업: "함께 일하기", 문서: "기록·문서", 학습: "배우기", 컨디션: "컨디션 관리", 기타: "그 밖의 시도" };
export function reportByRules(lessons, ctx) {
  const groups = new Map();
  for (const l of lessons || []) {
    for (const item of splitLines(l.try)) {
      const tag = themeOf(item) || themeOf(l.problem) || "기타";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(item);
    }
  }
  const themes = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([tag, items]) => ({ title: THEME_TITLE[tag] || tag, items: items.slice(0, 6) }));
  /* 인사이트(규칙) — 실제 문장을 인용해 근거를 보여 줌
     ① 여러 날 반복된 상황/문제 주제 ② 반복된 문제에 맞는 해볼 것이 없는 빈칸 ③ 여러 날 되풀이한 같은 다짐
     ④ 핵심 과업(작은 개구리)을 놓친 날과 그날의 상황/문제 (ctx.coreByDay가 있을 때) */
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const wd = (d) => { const [y, m, dd] = String(d).split("-").map(Number); return WD[new Date(y, m - 1, dd).getDay()]; };
  const short = (t) => { const x = String(t || "").split(/\n/)[0].replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, "").trim(); return x.length > 28 ? x.slice(0, 27) + "…" : x; };
  const name = (tag) => THEME_TITLE[tag] || tag;
  const probs = new Map();   // 주제 → [{date, text}]
  for (const l of lessons || []) { const t = themeOf(l.problem); if (t) { if (!probs.has(t)) probs.set(t, []); probs.get(t).push(l); } }
  const tryTags = new Set((lessons || []).flatMap((l) => splitLines(l.try).map((x) => themeOf(x)).filter(Boolean)));
  const repeated = [...probs.entries()].map(([t, ls]) => ({ t, ls, days: [...new Set(ls.map((l) => l.date))].sort() }))
    .filter((r) => r.days.length >= 2).sort((a, b) => b.days.length - a.days.length);
  const pts = [];
  const r0 = repeated[0];
  if (r0) pts.push(`${r0.days.map(wd).join("·")}, ${r0.days.length}일에 걸쳐 '${name(r0.t)}' 문제가 나왔어요 — "${short(r0.ls[r0.ls.length - 1].problem)}". 하루의 실수가 아니라 반복되는 패턴이에요.`);
  const gap = repeated.find((r) => !tryTags.has(r.t)) || [...probs.entries()].map(([t, ls]) => ({ t, ls })).find((r) => !tryTags.has(r.t) && r.ls.length >= 2);
  if (gap) pts.push(`'${name(gap.t)}' 문제는 ${gap.ls.length}번 적었는데, 이 문제를 겨냥한 해볼 것은 아직 없어요. 다른 쪽 다짐만 늘고 있는지 볼 만해요.`);
  const tryDays = new Map();
  for (const l of lessons || []) for (const x of splitLines(l.try)) { const t = themeOf(x); if (t) { if (!tryDays.has(t)) tryDays.set(t, new Map()); tryDays.get(t).set(l.date, x); } }
  const again = [...tryDays.entries()].filter(([, m]) => m.size >= 2).sort((a, b) => b[1].size - a[1].size)[0];
  if (again && pts.length < 3) pts.push(`'${name(again[0])}' 쪽 다짐을 ${again[1].size}일 되풀이했어요 — "${short([...again[1].values()].pop())}". 적은 다짐이 실제로 지켜지고 있는지 확인할 때예요.`);
  const cb = ctx?.coreByDay || {};
  const missed = Object.entries(cb).filter(([, v]) => v.total > 0 && v.done < v.total).map(([d]) => d).sort();
  if (missed.length && pts.length < 3) {
    const withProb = (lessons || []).filter((l) => missed.includes(l.date) && String(l.problem || "").trim());
    pts.push(withProb.length
      ? `작은 개구리를 놓친 ${missed.map(wd).join("·")}요일엔 "${short(withProb[0].problem)}" 같은 상황이 함께 있었어요.`
      : `${missed.map(wd).join("·")}요일엔 작은 개구리(핵심 과업)를 다 먹지 못했어요. 그날 무엇이 끼어들었는지 레슨런엔 남지 않았어요.`);
  }
  const noTry = (lessons || []).filter((l) => String(l.problem || "").trim() && !String(l.try || "").trim()).length;
  if (noTry && pts.length < 3) pts.push(`해볼 것 없이 남긴 상황/문제가 ${noTry}개 있어요. 원인까지는 적었지만 다음 행동은 비어 있어요.`);
  const insight = (lessons || []).length
    ? { headline: r0 ? `'${name(r0.t)}' 문제가 ${r0.days.length}일 반복된 한 주였어요` : top ? `해볼 것이 '${top.title}' 쪽으로 모인 한 주였어요` : "이번 주 레슨런을 돌아봤어요", points: pts.slice(0, 3) }
    : null;
  return { themes, insight };
}

/* 레슨런 굵게 — 글 안에서는 **굵게** 로 저장(노션에선 bold 주석으로 주고받음). 서버·앱 공용 */
export function splitBold(text) {
  const out = [];
  String(text || "").split(/(\*\*[^*]+?\*\*)/).forEach((part) => {
    if (!part) return;
    const m = part.match(/^\*\*([^*]+?)\*\*$/);
    out.push(m ? { t: m[1], bold: true } : { t: part, bold: false });
  });
  return out;
}
export const stripBold = (text) => String(text || "").replace(/\*\*([^*]+?)\*\*/g, "$1");

/* ── 이번 주 한 일 묶기(규칙) — AI가 없거나 실패할 때. 서버·앱 공용
   제목에서 과제 이름처럼 보이는 낱말을 뽑아, 낱말을 하나라도 같이 쓰는 과업끼리 묶음(union-find).
   한 건짜리는 '그 밖의 일'로 모음. tasks: [{id, title}] → [{title, ids}] */
const WORK_ALIAS = [
  [/hand\s*sign|핸드\s*사인/gi, "핸드사인"],
  [/결\.?\s*커\.?(?=\s|$|[^가-힣])|결제\s*커뮤니티/g, "결제커뮤니티"],
  [/마이\s*데이터|마데/g, "마이데이터"],
  [/n\s*pay|엔페이/gi, "npay"],
  [/배송\s*지/g, "배송지"],
  [/cx\s*(?:&|and)?\s*rm|cxrm/gi, "cxrm"],
  [/선행\s*과제/g, "선행과제"],
];
const WORK_STOP = new Set(["문의", "공유", "확인", "작성", "정리", "제작", "요청", "리스트업", "검토", "진행", "완료", "업뎃", "업데이트",
  "등록", "준비", "만들기", "회신", "논의", "추출", "이해", "도출", "구현", "가능여부", "개선", "개선안", "개선사항", "초안", "시안",
  "리서치", "레퍼런스", "전체", "플로우", "파트", "오늘", "내일", "하기", "빠르게", "진행되도록", "진행사항", "진행상황", "받기", "타기",
  "인계", "대표", "소재로", "소재", "가지", "사항", "케이스", "적용", "연결", "기획서", "기획", "프로토타입", "ut", "md", "파일",
  "f/u", "fu", "과제", "위키", "코멘트", "주간", "지표", "오류", "화면", "문서", "메일", "질문", "담당자", "1안", "2안", "3안", "생각", "하고", "싶은", "일", "건", "및", "후", "수준으로만", "수준", "할", "완성", "the", "and"]);
const workTokens = (title) => {
  let s = String(title || "")
    .replace(/https?:\/\/\S+/g, " ").replace(/\([^)]*\)/g, " ").replace(/@\S+/g, " ")
    .replace(/~?\s*\d{1,2}:\d{2}\s*(?:부터|까지)?/g, " ").replace(/\[([^\]]*)\]/g, " $1 ");
  for (const [re, to] of WORK_ALIAS) s = s.replace(re, ` ${to} `);
  const out = [];
  for (const raw of s.toLowerCase().split(/[^0-9a-z가-힣]+/)) {
    const w = strip(raw);
    if (w.length < 2 || /^\d+$/.test(w) || WORK_STOP.has(w) || STOP.has(w)) continue;
    if (/(?:하기|했음|하는|해서|하면)$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
};
export const OTHER_WORK = "그 밖의 일";
export function groupTasksByRules(tasks) {
  const list = (tasks || []).filter((t) => t && t.id);
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  /* 과제 이름은 보통 제목 앞쪽에 옴 — 첫 구분자(, + / ' - ') 앞에서 앞의 두 낱말로만 이음(뒤쪽 낱말로 엉뚱한 과제가 이어지지 않게) */
  const head = (t) => { const s = String(t || "").replace(/\([^)]*\)/g, " "); const m = s.split(/,|\+|\/|\s-\s/)[0]; return workTokens(m).length ? m : s; };
  const toks = list.map((t) => workTokens(head(t.title)).slice(0, 2));
  const owner = new Map();   // 낱말 → 처음 쓴 과업
  toks.forEach((ws, i) => ws.forEach((w) => {
    if (owner.has(w)) parent[find(i)] = find(owner.get(w)); else owner.set(w, i);
  }));
  const groups = new Map();
  list.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const out = [], rest = [];
  for (const idx of groups.values()) {
    if (idx.length < 2) { rest.push(...idx.map((i) => list[i].id)); continue; }
    const freq = new Map();
    idx.forEach((i) => toks[i].forEach((w) => freq.set(w, (freq.get(w) || 0) + 1)));
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const title = { 핸드사인: "핸드사인", 결제커뮤니티: "결제커뮤니티 진입점", 마이데이터: "마이데이터", npay: "Npay", cxrm: "CX·RM", 배송지: "배송지" }[top] || top;
    out.push({ title, ids: idx.map((i) => list[i].id) });
  }
  out.sort((a, b) => b.ids.length - a.ids.length);
  if (rest.length) out.push({ title: OTHER_WORK, ids: rest });
  return out;
}

/* 주간 회고 항목 — 점수(1~5) + 메모. 노션 '주간 회고' DB 속성 이름과 같음(메모는 '<항목> 메모'). 서버·앱 공용 */
export const WEEKLY_ITEMS = ["성과", "시간 관리", "업무량", "멘탈", "체력"];
