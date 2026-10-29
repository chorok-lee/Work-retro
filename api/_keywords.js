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
export function reportByRules(lessons) {
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
  const top = themes[0];
  const focus = top
    ? { text: top.items[0], why: top.items.length > 1 ? `이번 주 해볼 것 중 '${top.title}' 이야기가 ${top.items.length}번 나왔어요.` : "이번 주에 가장 먼저 적은 해볼 것이에요." }
    : null;
  return { themes, focus };
}
