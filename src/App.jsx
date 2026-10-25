import React, { useState, useEffect, useMemo, useRef } from "react";

/* ────────────────────────────────────────────────────────────
   업무 회고 — 개인 업무 루틴 트래커
   할 일(업무 루틴)마다 주간 목표 횟수를 두고, 날짜별로 체크합니다.
   [할 일] 탭: 날짜별 체크, 하루 평점  ·  [레슨런] 탭: 그날 배운 점 한 줄
   [회고] 탭: 지난주 대비 페이스, 이번 주 레슨런, 할 일별 기록
──────────────────────────────────────────────────────────── */

/* 노션 연결 전(로컬 모드)에 쓰는 기본 항목 */
const DEFAULT_ITEMS = [
  { id:"log",   name:"업무 일지 작성",      kind:"weekly", target:5 },
  { id:"plan",  name:"하루 우선순위 정리",  kind:"weekly", target:5 },
  { id:"deep",  name:"딥워크 2시간",        kind:"weekly", target:3 },
  { id:"learn", name:"학습 · 아티클 정리",  kind:"weekly", target:2 },
  { id:"retro", name:"주간 회고 작성",      kind:"weekly", target:1 },
];

const tgtOf = (h) => h.kind==="daily" ? 7 : h.target;
const freqLabel = (h) => tgtOf(h)>=7 ? "매일" : `주 ${tgtOf(h)}회`;
/* 주 7회(매일) → 주 1회 순으로, 같은 주기면 가나다순 */
const sortItems = (list) => [...(list||[])].sort((a,b)=>{
  const ta=tgtOf(a), tb=tgtOf(b);
  if(ta!==tb) return tb-ta;
  return String(a.name||"").localeCompare(String(b.name||""),"ko");
});

const toISO=(d)=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`;};
const fromISO=(s)=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const mondayOf=(d)=>{const x=new Date(d);x.setDate(x.getDate()-((x.getDay()+6)%7));return x;};
const weekDatesFrom=(mon)=>Array.from({length:7},(_,i)=>toISO(addDays(mon,i)));
/* 한 주는 월요일에 시작해서 일요일 23:59에 닫힙니다 */
const DAYS=["월","화","수","목","금","토","일"];
/* "10월 3주차" — 주가 두 달에 걸치면 목요일이 속한 달로 셉니다 */
const weekOfMonth=(monISO)=>{const th=addDays(fromISO(monISO),3);return {m:th.getMonth()+1,w:Math.ceil(th.getDate()/7)};};
/* 노션 시각(UTC) 또는 날짜 → 이 기기 기준 YYYY-MM-DD */
const localISO=(s)=>{if(!s)return "";if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;const d=new Date(s);return isNaN(d)?"":toISO(d);};

/* ── 저장 계층 ───────────────────────────────────────────────
   1순위: 노션 (앱 내부 /api 경유 — 토큰은 서버에만 존재)
   2순위: 브라우저 localStorage (노션 미설정·오류 시 자동 전환)
─────────────────────────────────────────────────────────── */
const LS={
  get(k){try{return localStorage.getItem(k);}catch(e){return null;}},
  set(k,v){try{localStorage.setItem(k,v);}catch(e){}},
};

async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{"Content-Type":"application/json",...(opts.headers||{})}});
  let data=null; try{data=await r.json();}catch(e){}
  if(!r.ok) throw new Error(data?.hint||data?.error||`요청 실패 (${r.status})`);
  if(data===null) throw new Error("API 서버에 연결하지 못해 이 기기에만 저장되고 있어요. (로컬에서는 vercel dev로 실행)");
  return data;
}

/* 마지막으로 노션에서 받은 데이터를 기기에 저장해 두었다가 다음에 바로 띄웁니다 */
const CACHE_KEY="wr_cache_v1";
const readCache=()=>{
  try{const c=JSON.parse(LS.get(CACHE_KEY)||"null");return c&&Array.isArray(c.res?.items)&&c.res.items.length&&c.logs?c:null;}
  catch(e){return null;}
};
/* 처음엔 최근 8주만 받아 화면을 띄우고, 1년 치 나머지는 뒤에서 이어 받습니다 */
const RECENT_WEEKS=8;
/* fresh가 덮는 날짜 구간은 fresh로 교체, 나머지는 기존 값 유지 */
const mergeLogs=(prev,fresh,{from,to})=>{
  const out={};
  for(const k of Object.keys(prev))if((from&&k<from)||(to&&k>to))out[k]=prev[k];
  return {...out,...fresh};
};

/* 노션 기록 배열 → { "YYYY-MM-DD": [항목id, ...] } */
function logsToMap(rows){
  const out={};
  for(const row of rows||[]){
    if(!row?.date||!row?.itemId) continue;
    if(!out[row.date]) out[row.date]=[];
    out[row.date].push(row.itemId);
  }
  return out;
}

export default function App(){
  const [cache0]=useState(readCache);
  const [items,setItems]=useState(()=>cache0?cache0.res.items:[]);
  const [logs,setLogs]=useState(()=>cache0?cache0.logs:{});
  const [tab,setTab]=useState("todo");
  const [selDate,setSelDate]=useState(toISO(new Date()));
  const [loaded,setLoaded]=useState(!!cache0);

  /* 노션 연결 상태: loading | notion | local */
  const [sync,setSync]=useState({mode:cache0?"notion":"loading",error:""});
  const [toast,setToast]=useState("");
  const [itemsDb,setItemsDb]=useState(()=>cache0?.res.itemsDb||"");
  const [ownerWarn,setOwnerWarn]=useState("");
  const [staleWarn,setStaleWarn]=useState("");
  const resRef=useRef(cache0?.res||null);
  const olderDone=useRef(false);
  const pending=useRef(new Map());   // 노션에 저장 중인 체크 — 새로 받은 데이터에 덮이지 않도록

  /* 레슨런: 노션 레슨런 DB, 연결 안 되면 이 기기에 저장 */
  const [lessons,setLessons]=useState(()=>Array.isArray(cache0?.lessons)?cache0.lessons:[]);
  const [lessonMode,setLessonMode]=useState(cache0?.lessons?"notion":"loading");   // loading | notion | local
  const [lessonNote,setLessonNote]=useState("");
  const lessonModeRef=useRef(lessonMode); lessonModeRef.current=lessonMode;

  /* 하루 평점 { "YYYY-MM-DD": 1~5 } — 노션 하루 평점 DB, 연결 안 되면 이 기기에 저장 */
  const [ratings,setRatings]=useState(()=>cache0?.ratings&&typeof cache0.ratings==="object"?cache0.ratings:{});
  const [ratingMode,setRatingMode]=useState(cache0?.ratings?"notion":"loading");
  const ratingModeRef=useRef(ratingMode); ratingModeRef.current=ratingMode;
  /* 저녁 6시~자정에는 평점 모듈을 펼쳐 둡니다 — 시각이 바뀌는 걸 1분마다 확인 */
  const [hour,setHour]=useState(()=>new Date().getHours());
  useEffect(()=>{const t=setInterval(()=>setHour(new Date().getHours()),60000);return()=>clearInterval(t);},[]);

  /* 항목 상세 — 주소에 #item/<id>를 붙여 뒤로가기로 닫히게 */
  const hashId=()=>{const m=(window.location.hash||"").match(/^#item\/(.+)$/);return m?decodeURIComponent(m[1]):null;};
  const [detailId,setDetailId]=useState(hashId);
  const pushedDetail=useRef(false);
  useEffect(()=>{const on=()=>setDetailId(hashId());window.addEventListener("popstate",on);return()=>window.removeEventListener("popstate",on);},[]);
  const openDetail=(id)=>{window.history.pushState({d:1},"",`#item/${encodeURIComponent(id)}`);pushedDetail.current=true;setDetailId(id);};
  const closeDetail=()=>{
    if(pushedDetail.current){pushedDetail.current=false;window.history.back();}
    else{window.history.replaceState(null,"",window.location.pathname+window.location.search);setDetailId(null);}
  };

  /* 저장 중이거나, 조회를 시작한 뒤에 한 체크를 새로 받은 기록 위에 다시 얹기 */
  const withPending=(map,started)=>{
    for(const [key,v] of pending.current)if(!v.inflight&&v.at<started)pending.current.delete(key);
    if(!pending.current.size)return map;
    const out={...map};
    for(const [key,{on}] of pending.current){
      const [id,d]=key.split("|");const day=out[d]||[];
      const next=on?(day.includes(id)?day:[...day,id]):day.filter(x=>x!==id);
      if(next.length)out[d]=next;else delete out[d];
    }
    return out;
  };

  const loadFromNotion=async()=>{
    const now=new Date(),to=toISO(now),started=Date.now();
    const from=toISO(addDays(mondayOf(now),-(RECENT_WEEKS-1)*7));
    const [res,ls]=await Promise.all([api("/api/items"),api(`/api/logs?from=${from}&to=${to}`)]);
    if(!Array.isArray(res?.items)||!res.items.length)
      throw new Error("노션에서 가져온 할 일이 없어요. '활성' 체크가 켜진 할 일이 있는지 확인해주세요.");
    resRef.current=res;
    setItems(res.items);
    /* 직전이 로컬 모드였다면 그 기록은 섞지 않음 */
    setLogs(prev=>withPending(mergeLogs(sync.mode==="local"?{}:prev,logsToMap(ls?.logs),{from,to}),started));
    if(res.itemsDb) setItemsDb(res.itemsDb);
    setOwnerWarn(res.ownerWarn||"");
    return {from};
  };

  /* 8주보다 오래된 기록(최근 1년)은 화면을 띄운 뒤 받아 합칩니다 */
  const loadOlder=async(recentFrom)=>{
    if(olderDone.current)return;
    const from=toISO(addDays(mondayOf(new Date()),-53*7));
    const to=toISO(addDays(fromISO(recentFrom),-1)),started=Date.now();
    try{
      const ls=await api(`/api/logs?from=${from}&to=${to}`);
      setLogs(prev=>withPending(mergeLogs(prev,logsToMap(ls?.logs),{from,to}),started));
      olderDone.current=true;
    }catch(e){ /* 다음에 앱으로 돌아올 때 다시 시도 */ }
  };

  const loadFromLocal=()=>{
    const h=LS.get("wr_items"),l=LS.get("wr_logs");
    if(h){try{setItems(JSON.parse(h));}catch{setItems(DEFAULT_ITEMS);}}
    else setItems(DEFAULT_ITEMS);
    if(l)try{setLogs(JSON.parse(l));}catch{}
  };

  const loadLessonsLocal=(why)=>{
    try{const l=JSON.parse(LS.get("wr_lessons")||"[]");setLessons(Array.isArray(l)?l:[]);}catch{setLessons([]);}
    setLessonMode("local"); setLessonNote(why||"");
  };
  const loadLessons=async()=>{
    const from=toISO(addDays(mondayOf(new Date()),-53*7));
    try{
      const r=await api(`/api/lessons?from=${from}`);
      setLessons(Array.isArray(r?.lessons)?r.lessons:[]);
      setLessonMode("notion"); setLessonNote("");
    }catch(e){
      /* 이미 노션 레슨런을 보여주는 중이면 그대로 둠 */
      if(lessonModeRef.current!=="notion") loadLessonsLocal(`레슨런 DB에 연결하지 못해 이 기기에만 저장돼요. ${e.message||""}`);
    }
  };

  const loadRatingsLocal=()=>{
    try{const r=JSON.parse(LS.get("wr_ratings")||"{}");setRatings(r&&typeof r==="object"?r:{});}catch{setRatings({});}
    setRatingMode("local");
  };
  const loadRatings=async()=>{
    const from=toISO(addDays(mondayOf(new Date()),-53*7));
    try{
      const r=await api(`/api/ratings?from=${from}`);
      const map={}; for(const x of r?.ratings||[]) if(x.date&&x.score) map[x.date]=x.score;
      setRatings(map); setRatingMode("notion");
    }catch(e){
      if(ratingModeRef.current!=="notion") loadRatingsLocal();
    }
  };

  const lastLoad=useRef(0);
  const refresh=async()=>{
    try{
      const info=await loadFromNotion();
      setSync({mode:"notion",error:""});
      setStaleWarn("");
      loadOlder(info.from);
      loadLessons();
      loadRatings();
    }
    catch(e){
      if(sync.mode==="notion") setStaleWarn("노션에 연결하지 못해 마지막으로 불러온 기록을 보여주고 있어요.");
      else { loadFromLocal(); loadLessonsLocal(""); loadRatingsLocal(); setSync({mode:"local",error:e.message||"노션에 연결하지 못했어요."}); }
    }
    finally{ setLoaded(true); lastLoad.current=Date.now(); }
  };
  const refreshRef=useRef(refresh); refreshRef.current=refresh;

  useEffect(()=>{refresh();},[]);

  /* 앱으로 돌아올 때 노션 내용을 다시 불러옵니다 */
  useEffect(()=>{
    const back=()=>{
      if(document.visibilityState!=="visible")return;
      if(Date.now()-lastLoad.current<20000)return;
      refreshRef.current();
    };
    document.addEventListener("visibilitychange",back);
    window.addEventListener("focus",back);
    return()=>{document.removeEventListener("visibilitychange",back);window.removeEventListener("focus",back);};
  },[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(""),3800);return()=>clearTimeout(t);},[toast]);
  useEffect(()=>{if(loaded&&sync.mode==="local")LS.set("wr_items",JSON.stringify(items));},[items,loaded,sync.mode]);
  useEffect(()=>{if(loaded&&sync.mode==="local")LS.set("wr_logs",JSON.stringify(logs));},[logs,loaded,sync.mode]);
  useEffect(()=>{if(lessonMode==="local")LS.set("wr_lessons",JSON.stringify(lessons));},[lessons,lessonMode]);
  useEffect(()=>{if(ratingMode==="local")LS.set("wr_ratings",JSON.stringify(ratings));},[ratings,ratingMode]);
  useEffect(()=>{
    if(!loaded||sync.mode!=="notion"||!resRef.current)return;
    LS.set(CACHE_KEY,JSON.stringify({res:resRef.current,logs,lessons:lessonMode==="notion"?lessons:undefined,
      ratings:ratingMode==="notion"?ratings:undefined,savedAt:Date.now()}));
  },[items,logs,lessons,lessonMode,ratings,ratingMode,loaded,sync.mode]);

  const today=toISO(new Date());
  const selMon=mondayOf(fromISO(selDate)),weekStart=toISO(selMon);
  const weekDates=useMemo(()=>weekDatesFrom(selMon),[weekStart]);
  const isLogged=(id,d)=>(logs[d]||[]).includes(id);
  const applyToggle=(id,d)=>setLogs(prev=>{
    const day=prev[d]||[];const next=day.includes(id)?day.filter(x=>x!==id):[...day,id];
    const out={...prev,[d]:next};if(!next.length)delete out[d];return out;
  });
  /* 체크 → 화면 먼저 바꾸고 노션에 기록. 실패하면 되돌림 */
  const toggleLog=async(id,d)=>{
    const wasOn=isLogged(id,d);
    applyToggle(id,d);
    if(sync.mode!=="notion") return;
    const key=`${id}|${d}`;
    const mark={on:!wasOn,at:Date.now(),inflight:true};
    pending.current.set(key,mark);
    try{
      await api("/api/logs",{method:wasOn?"DELETE":"POST",body:JSON.stringify({itemId:id,date:d})});
      mark.inflight=false;
    }catch(e){
      if(pending.current.get(key)===mark)pending.current.delete(key);
      applyToggle(id,d);
      setToast(e.message||"노션에 저장하지 못했어요. 잠시 후 다시 시도해주세요.");
    }
  };
  const weekCount=(id,wd=weekDates)=>wd.reduce((n,d)=>n+(isLogged(id,d)?1:0),0);

  /* 레슨런 추가·삭제 — 화면 먼저 바꾸고 노션에 저장, 실패하면 되돌림 */
  const addLesson=async(text,date)=>{
    const tmp={id:"tmp"+Date.now(),date,text};
    setLessons(p=>[tmp,...p]);
    if(lessonMode!=="notion"){setLessons(p=>p.map(l=>l.id===tmp.id?{...l,id:"l"+Date.now()}:l));return;}
    try{
      const r=await api("/api/lessons",{method:"POST",body:JSON.stringify({text,date})});
      setLessons(p=>p.map(l=>l.id===tmp.id?{...l,id:r.id}:l));
    }catch(e){
      setLessons(p=>p.filter(l=>l.id!==tmp.id));
      setToast(e.message||"레슨런을 저장하지 못했어요.");
      throw e;
    }
  };
  /* 하루 평점 — 같은 별을 다시 누르면 지움(0) */
  const setRating=async(date,score)=>{
    const prev=ratings[date]||0;
    const apply=(v)=>setRatings(p=>{const o={...p};if(v)o[date]=v;else delete o[date];return o;});
    apply(score);
    if(ratingMode!=="notion") return;
    try{ await api("/api/ratings",{method:"PUT",body:JSON.stringify({date,score})}); }
    catch(e){ apply(prev); setToast(e.message||"평점을 저장하지 못했어요."); }
  };
  const delLesson=async(id)=>{
    const prev=lessons;
    setLessons(p=>p.filter(l=>l.id!==id));
    if(lessonMode!=="notion"||String(id).startsWith("tmp")) return;
    try{ await api("/api/lessons",{method:"DELETE",body:JSON.stringify({id})}); }
    catch(e){ setLessons(prev); setToast(e.message||"삭제하지 못했어요."); }
  };

  /* 항목별 시작일 = 노션 시작일(또는 생성일)과 가장 이른 기록 중 빠른 쪽 */
  const firstLog=useMemo(()=>{
    const out={};
    for(const d of Object.keys(logs).sort())for(const id of logs[d])if(!out[id])out[id]=d;
    return out;
  },[logs]);
  const startOf=(h)=>{
    const a=localISO(h.start),b=firstLog[h.id]||"";
    return a&&b?(a<b?a:b):(a||b);   // 둘 다 모르면 비워둬서 가리지 않음
  };

  const isNotion=sync.mode==="notion";
  const list=sortItems(items);
  const detailItem=detailId?items.find(h=>h.id===detailId)||null:null;
  const curMon=mondayOf(fromISO(today));

  /* ── 페이스: 지난주 같은 요일까지 vs 이번 주 지금까지 ── */
  const paceOf=(list)=>{
    if(!list.length) return null;
    const todayIdx=(fromISO(today).getDay()+6)%7;
    const dayCount=(iso)=>list.reduce((n,h)=>n+(isLogged(h.id,iso)?1:0),0);
    const cumul=(mon)=>{let c=0;return weekDatesFrom(mon).map(d=>(c+=dayCount(d)));};
    const cur=cumul(curMon), prev=cumul(addDays(curMon,-7));
    const now=cur[todayIdx], then=prev[todayIdx];
    const curWeek=weekDatesFrom(curMon);
    const left=(h)=>tgtOf(h)-curWeek.reduce((n,d)=>n+(isLogged(h.id,d)?1:0),0);
    /* 이 속도면 채울 수 있는 목표 수 */
    const onTrack=list.filter(h=>{const wc=tgtOf(h)-left(h);return wc/(todayIdx+1)*7>=tgtOf(h);}).length;
    /* 최고 기록 주 (불러온 1년 안, 이번 주 제외) */
    let best=0,bestMon=null;
    for(let i=1;i<=52;i++){
      const mon=addDays(curMon,-7*i);
      const tot=weekDatesFrom(mon).reduce((n,d)=>n+dayCount(d),0);
      if(tot>best){best=tot;bestMon=toISO(mon);}
    }
    return {todayIdx,cur,prev,now,then,diff:now-then,onTrack,total:list.length,best,bestMon};
  };

  /* ── 항목 하나의 기록 통계 — 회고 목록·상세 페이지가 함께 씀 ──
     칸 상태: full(목표 채운 주의 체크) · part(못 채운 주의 체크) · empty · pre(시작 전) · future
     연속: 매일 항목은 '일', 주 N회 항목은 '주' 단위 */
  const itemStats=(h)=>{
    const t=tgtOf(h), daily=t>=7;
    const yearAgo=toISO(addDays(fromISO(today),-364));
    const startISO=startOf(h)||yearAgo;
    const weekCnt={};
    const cntOf=(mon)=>{const k=toISO(mon);if(weekCnt[k]==null)weekCnt[k]=weekDatesFrom(mon).reduce((n,d)=>n+(isLogged(h.id,d)?1:0),0);return weekCnt[k];};
    const cell=(iso)=>{
      if(iso>today) return "future";
      if(iso<startISO) return "pre";
      if(!isLogged(h.id,iso)) return "empty";
      return cntOf(mondayOf(fromISO(iso)))>=t?"full":"part";
    };
    const days=[]; for(let d=fromISO(startISO>yearAgo?startISO:yearAgo);toISO(d)<=today;d=addDays(d,1)) days.push(toISO(d));
    const logged=days.filter(d=>isLogged(h.id,d));
    let cur=0,best=0;
    if(daily){
      let run=0; for(const d of days){ run=isLogged(h.id,d)?run+1:0; best=Math.max(best,run); }
      let i=days.length-1; if(i>=0&&!isLogged(h.id,days[i])) i--;          // 오늘 아직이면 어제부터
      while(i>=0&&isLogged(h.id,days[i])){cur++;i--;}
    }else{
      const mons=[]; for(let m=mondayOf(fromISO(days[0]||today));toISO(m)<=today;m=addDays(m,7)) mons.push(m);
      let run=0; for(const m of mons){ run=cntOf(m)>=t?run+1:0; best=Math.max(best,run); }
      let i=mons.length-1; if(i>=0&&cntOf(mons[i])<t) i--;                 // 이번 주 진행 중이면 지난주부터
      while(i>=0&&cntOf(mons[i])>=t){cur++;i--;}
    }
    const wc=cntOf(curMon);
    /* 최근 12주(이번 주 제외, 시작 이후) 중 목표를 채운 주 */
    let ok=0,elig=0; for(let i=1;i<=12;i++){const m=addDays(curMon,-7*i); if(toISO(addDays(m,6))<startISO) continue; elig++; if(cntOf(m)>=t) ok++;}
    return {h,t,daily,unit:daily?"일":"주",cell,cur,best,total:logged.length,startISO,
      wc,weekPct:Math.min(1,wc/t),ok,elig,rate:elig?ok/elig:null,
      records:[...logged].reverse(),todayOn:isLogged(h.id,today),started:startISO<=today};
  };

  /* 평점 모듈: 오늘이고 저녁 6시~자정이면 펼침. 직접 접거나 펼치면 그 날짜에선 그 선택을 따름 */
  const [ratingToggle,setRatingToggle]=useState({});   // { date: true|false }
  const ratingAuto=selDate===today&&hour>=18;
  const ratingOpen=ratingToggle[selDate]??ratingAuto;

  /* 선택한 날짜 하루의 진행 */
  const dayDone=list.filter(h=>isLogged(h.id,selDate)).length;

  const booting=!loaded||sync.mode==="loading";
  const notice = sync.mode==="local"
    ? (sync.error || "노션에 연결하지 못해 이 기기에만 저장되고 있어요.")
    : (isNotion && (staleWarn || ownerWarn)) || "";
  const selD=fromISO(selDate);
  const selWk=weekOfMonth(weekStart);
  const dayLabel=selDate===today?"오늘":`${selD.getMonth()+1}월 ${selD.getDate()}일`;
  const thisWeekLessons=lessons.filter(l=>l.date>=toISO(curMon)&&l.date<=today);

  /* 할 일·레슨런 탭이 함께 쓰는 날짜 이동 */
  const dateStepper=(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,margin:"8px 0 12px"}}>
      <button className="btn icon" aria-label="이전 날" onClick={()=>setSelDate(toISO(addDays(selD,-1)))}>‹</button>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:16,fontWeight:700}}>{selD.getMonth()+1}월 {selD.getDate()}일 ({DAYS[(selD.getDay()+6)%7]})</div>
        <div style={{fontSize:12,color:"var(--sub)",marginTop:2}}>
          {selWk.m}월 {selWk.w}주차{selDate!==today&&<> · <button className="link" onClick={()=>setSelDate(today)}>오늘로</button></>}
        </div>
      </div>
      <button className="btn icon" aria-label="다음 날" disabled={selDate>=today}
        onClick={()=>{const n=addDays(selD,1);if(toISO(n)<=today)setSelDate(toISO(n));}}>›</button>
    </div>
  );

  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="wrap">
        <header className="navbar">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <h1 style={{fontSize:17,fontWeight:700,margin:0,letterSpacing:"-0.01em"}}>업무 회고</h1>
            <div role="tablist" className="seg">
              {[["todo","할 일"],["lessons","레슨런"],["review","회고"]].map(([k,l])=>(
                <button key={k} role="tab" aria-selected={tab===k} className={"btn"+(tab===k?" on":"")} onClick={()=>setTab(k)}>{l}</button>
              ))}
            </div>
          </div>
          {notice&&<div className="notice">{notice}</div>}
        </header>

        {booting&&<LoadingView/>}

        {!booting&&tab==="todo"&&(
          <div className="fade">
            {dateStepper}

            {/* 하루 진행 */}
            {list.length>0&&
              <div className="card" style={{padding:"14px 16px",marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:13}}>
                  <span style={{color:"var(--sub)"}}>{dayLabel} 진행</span>
                  <span className="mono"><b>{dayDone}</b><span style={{color:"var(--sub)"}}> / {list.length}개 완료</span></span>
                </div>
                <div className="bar" style={{marginTop:10}}><div style={{width:`${dayDone/list.length*100}%`}}/></div>
              </div>}

            <RatingCard label={dayLabel} score={ratings[selDate]||0} open={ratingOpen}
              onToggle={()=>setRatingToggle(t=>({...t,[selDate]:!ratingOpen}))}
              onRate={(n)=>setRating(selDate,n===(ratings[selDate]||0)?0:n)}/>

            {/* 할 일 목록 */}
            {list.length>0&&
              <div className="card" style={{padding:4}}>
                {list.map((h,i)=>{
                  const on=isLogged(h.id,selDate),wc=weekCount(h.id),t=tgtOf(h);
                  return(
                    <div key={h.id} className="row" role="checkbox" aria-checked={on} tabIndex={0}
                      onClick={()=>toggleLog(h.id,selDate)}
                      onKeyDown={e=>{if(e.key===" "||e.key==="Enter"){e.preventDefault();toggleLog(h.id,selDate);}}}
                      style={{borderTop:i?"1px solid var(--line)":"none"}}>
                      <span className={"chk"+(on?" on":"")} aria-hidden="true">{on?"✓":""}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:15,fontWeight:500,wordBreak:"keep-all"}}>{h.name}</div>
                        <div className="mono" style={{fontSize:12,color:"var(--sub)",marginTop:2}}>{freqLabel(h)}</div>
                      </div>
                      <span className="mono" style={{fontSize:13,fontWeight:600,color:wc>=t?"var(--acc)":"var(--sub)"}}>{Math.min(wc,t)}/{t}</span>
                    </div>
                  );
                })}
              </div>}

            {/* 할 일 추가·수정은 노션 DB에서 */}
            {itemsDb&&
              <a className="link" href={`https://www.notion.so/${String(itemsDb).replace(/-/g,"")}`} target="_blank" rel="noopener noreferrer"
                style={{display:"block",width:"fit-content",margin:"16px auto 0",fontSize:13}}>관리하기</a>}
          </div>
        )}

        {!booting&&tab==="lessons"&&(
          <LessonsTab dateStepper={dateStepper} selDate={selDate} dayLabel={dayLabel} today={today}
            lessons={lessons} note={lessonNote} onAdd={addLesson} onDelete={delLesson}/>
        )}

        {!booting&&tab==="review"&&(
          <div className="fade">
            <PaceCard p={paceOf(list)}/>
            <div className="card" style={{padding:"14px 16px",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:13}}>
                <span style={{color:"var(--sub)"}}>이번 주 레슨런</span>
                <span className="mono" style={{color:"var(--sub)"}}>{thisWeekLessons.length}개</span>
              </div>
              {thisWeekLessons.length===0
                ? <div style={{fontSize:13,color:"var(--sub)",marginTop:8}}>아직 없어요. 레슨런 탭에서 남길 수 있어요.</div>
                : <ul className="lessons-mini">
                    {thisWeekLessons.map(l=><li key={l.id}><span className="mono">{DAYS[(fromISO(l.date).getDay()+6)%7]}</span>{l.text}</li>)}
                  </ul>}
            </div>
            {list.length>0&&
              <div className="card" style={{padding:4}}>
                {list.map((h,i)=>(
                  <ItemRow key={h.id} st={itemStats(h)} today={today} first={i===0} onOpen={()=>openDetail(h.id)}/>
                ))}
              </div>}
          </div>
        )}
      </div>
      {detailItem&&<ItemDetail st={itemStats(detailItem)} today={today} isNotion={isNotion}
        onClose={closeDetail} onCheckToday={()=>toggleLog(detailItem.id,today)}/>}
      {toast&&<div className="toast fade">{toast}</div>}
    </div>
  );
}

/* ── 로딩: 실제 화면과 같은 자리의 뼈대 ── */
function LoadingView(){
  return(
    <div className="fade" role="status" aria-label="불러오는 중">
      <div className="sk" style={{height:44,margin:"8px 0 12px"}}/>
      <div className="sk" style={{height:66,marginBottom:12}}/>
      <div className="sk" style={{height:280}}/>
    </div>
  );
}

/* ── 페이스 카드: 지난주 같은 요일까지 vs 이번 주 지금까지 ──
   월→일 누적 체크 수 (지난주 점선 / 이번 주 실선) */
function PaceCard({p}){
  const [hi,setHi]=useState(null);
  if(!p) return null;
  const {todayIdx,cur,prev,now,diff,onTrack,total,best,bestMon}=p;
  const W=560,H=75,PX=24,PT=9,PB=7;
  const max=Math.max(prev[6],now,1);
  const X=(i)=>PX+(W-PX*2)*i/6, Y=(v)=>PT+(H-PT-PB)*(1-v/max);
  const pts=(arr,n)=>arr.slice(0,n).map((v,i)=>`${X(i)},${Y(v)}`).join(" ");
  const big=diff>0?`+${diff}`:`${diff}`;
  const label=diff>0?`지난주 ${DAYS[todayIdx]}요일까지보다 ${diff}회 많아요`
    :diff===0?`지난주 ${DAYS[todayIdx]}요일까지와 같아요`:`지난주 ${DAYS[todayIdx]}요일까지보다 ${-diff}회 적어요`;
  const wk=bestMon&&weekOfMonth(bestMon);
  const pick=(e)=>{const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width*W;
    setHi(Math.max(0,Math.min(6,Math.round((x-PX)/((W-PX*2)/6)))));};

  return(
    <div className="card" style={{padding:"18px 16px",marginBottom:12}}>
      <div style={{fontSize:13,color:"var(--sub)"}}>이번 주 누적 체크</div>
      <div style={{display:"flex",alignItems:"baseline",gap:10,marginTop:6}}>
        <span className="mono" style={{fontSize:32,fontWeight:700,letterSpacing:"-0.02em",lineHeight:1}}>{now}회</span>
        <span className="mono" style={{fontSize:14,fontWeight:600,color:diff>0?"var(--acc)":diff<0?"var(--neg)":"var(--sub)"}}>{diff===0?"±0":big}</span>
      </div>
      <div style={{fontSize:13,color:"var(--sub)",marginTop:6}}>{label}</div>

      <div style={{position:"relative",marginTop:16}} onPointerMove={pick} onPointerDown={pick}
        onPointerLeave={e=>{if(e.pointerType==="mouse")setHi(null);}}>
        {hi!=null&&
          <div className="tip" style={{left:`${X(hi)/W*100}%`,transform:`translate(${hi<=1?"-12%":hi>=5?"-88%":"-50%"},-100%)`}}>
            <div style={{fontWeight:600,marginBottom:2}}>{DAYS[hi]}요일까지</div>
            <div style={{color:"var(--acc)"}}>이번 주 <b>{hi<=todayIdx?`${cur[hi]}회`:"–"}</b></div>
            <div style={{color:"var(--sub)"}}>지난주 <b style={{color:"var(--ink)"}}>{prev[hi]}회</b></div>
          </div>}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{display:"block",overflow:"visible",touchAction:"pan-y"}} aria-hidden="true">
          {[0,.5,1].map(f=><line key={f} x1={PX} x2={W-PX} y1={Y(max*f)} y2={Y(max*f)} stroke="var(--line)" strokeWidth="1"/>)}
          {hi!=null&&<line x1={X(hi)} x2={X(hi)} y1={PT-8} y2={H-PB+4} stroke="var(--sub)" strokeOpacity=".5" strokeWidth="1" strokeDasharray="3 4"/>}
          <polyline points={pts(prev,7)} fill="none" stroke="var(--sub)" strokeOpacity=".7" strokeWidth="2"
            strokeDasharray="5 6" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points={pts(cur,todayIdx+1)} fill="none" stroke="var(--acc)" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"/>
          {hi!=null&&<circle cx={X(hi)} cy={Y(prev[hi])} r="4" fill="var(--sub)"/>}
          {hi!=null&&hi<todayIdx&&<circle cx={X(hi)} cy={Y(cur[hi])} r="4" fill="var(--acc)"/>}
          <circle cx={X(todayIdx)} cy={Y(now)} r="5" fill="var(--acc)" stroke="var(--surface)" strokeWidth="2"/>
        </svg>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",padding:`6px ${PX/W*100}% 0`,fontSize:12}}>
        {DAYS.map((d,i)=><span key={d} style={{width:0,display:"flex",justifyContent:"center",
          color:i===todayIdx?"var(--ink)":"var(--sub)",fontWeight:i===todayIdx?700:400,opacity:i>todayIdx?.5:1}}>{d}</span>)}
      </div>
      <div style={{display:"flex",gap:14,marginTop:12,fontSize:12,color:"var(--sub)"}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}><i className="lg" style={{background:"var(--acc)"}}/>이번 주</span>
        <span style={{display:"flex",alignItems:"center",gap:6}}><i className="lg dash"/>지난주</span>
      </div>

      <div className="kv" style={{marginTop:16}}>
        <div><span>현재 페이스로 목표 달성</span><b className="mono">{onTrack}/{total}개</b></div>
        {best>0&&<div><span>최고 기록 주</span><b className="mono">{now>best?"이번 주":`${wk.m}월 ${wk.w}주차`} · {Math.max(best,now)}회</b></div>}
      </div>
    </div>
  );
}

/* ── 잔디 ── 세로 7칸(월~일) × N주 */
const GRASS_BG={full:"var(--acc)",part:"rgba(var(--acc-rgb),.35)",empty:"var(--cell)",pre:"var(--cell-pre)",future:"transparent"};
function Grass({cell,endISO,weeks,today,gap=3,radius=3}){
  const endMon=mondayOf(fromISO(endISO));
  const cols=Array.from({length:weeks},(_,i)=>addDays(endMon,-(weeks-1-i)*7));
  const firstOf=cols.map(m=>weekDatesFrom(m).find(x=>x.endsWith("-01")));
  /* 그 주에 1일이 있으면 월 표시. 첫 칸은 바로 옆 칸에 월 표시가 없을 때만 (글자 겹침 방지) */
  const monthAt=cols.map((m,i)=>firstOf[i]?fromISO(firstOf[i]).getMonth()+1:i===0&&!firstOf[1]?m.getMonth()+1:null);
  const lab={fontSize:11,color:"var(--sub)",lineHeight:1,whiteSpace:"nowrap"};
  const kids=[<span key="dm"/>];
  DAYS.forEach((d,i)=>kids.push(<span key={"d"+i} style={{...lab,display:"flex",alignItems:"center",paddingRight:4,visibility:i%2===0?"visible":"hidden"}}>{d}</span>));
  cols.forEach((m,ci)=>{
    kids.push(<span key={"m"+ci} style={{...lab,width:0,overflow:"visible",alignSelf:"end"}}>{monthAt[ci]?`${monthAt[ci]}월`:""}</span>);
    weekDatesFrom(m).forEach(iso=>{
      const st=cell(iso);
      kids.push(<span key={iso} title={iso} style={{aspectRatio:"1",borderRadius:radius,background:GRASS_BG[st],
        boxShadow:iso===today?"0 0 0 1.5px var(--ink)":"none"}}/>);
    });
  });
  return(
    <div style={{display:"grid",gridTemplateColumns:`auto repeat(${weeks},minmax(0,1fr))`,
      gridTemplateRows:`16px repeat(7,auto)`,gridAutoFlow:"column",columnGap:gap,rowGap:gap,minWidth:0}}>
      {kids}
    </div>
  );
}

/* 회고 목록의 한 행 — 이름 + 연속 기록 | 최근 3주 잔디 · 누르면 상세 */
function ItemRow({st,today,first,onOpen}){
  const mon0=addDays(mondayOf(fromISO(today)),-14);
  const weeks=[0,1,2].map(i=>weekDatesFrom(addDays(mon0,i*7)));
  return(
    <button className="btn row" onClick={onOpen} aria-label={`${st.h.name} 자세히 보기`}
      style={{width:"100%",textAlign:"left",background:"transparent",border:"none",borderTop:first?"none":"1px solid var(--line)",color:"inherit"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:15,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st.h.name}</div>
        <div className="mono" style={{fontSize:12,marginTop:3,color:"var(--sub)"}}>
          이번 주 {Math.min(st.wc,st.t)}/{st.t}{st.cur>0&&<> · <span style={{color:"var(--acc)",fontWeight:600}}>{st.cur}{st.unit} 연속</span></>}
        </div>
      </div>
      <div aria-hidden="true" style={{display:"grid",gridTemplateColumns:"repeat(7,11px)",gap:3,flex:"0 0 auto"}}>
        {weeks.flat().map(iso=>{const k=st.cell(iso);return <span key={iso} title={iso} style={{width:11,height:11,borderRadius:2,
          background:GRASS_BG[k],boxShadow:iso===today?"0 0 0 1.5px var(--ink)":"none"}}/>;})}
      </div>
      <span aria-hidden="true" style={{fontSize:18,color:"var(--sub)",lineHeight:1,flex:"0 0 auto"}}>›</span>
    </button>
  );
}

/* ── 항목 상세 ── 잔디 · 통계 4개 · 월별 기록 */
const PAGE_WEEKS=22;
function ItemDetail({st,today,isNotion,onClose,onCheckToday}){
  const [page,setPage]=useState(0);
  const maxPage=Math.floor(52/PAGE_WEEKS);
  const endISO=toISO(addDays(mondayOf(fromISO(today)),-7*PAGE_WEEKS*page+6));
  const startISO=toISO(addDays(fromISO(endISO),-(7*PAGE_WEEKS-1)));
  const md=(iso)=>{const d=fromISO(iso);return `${d.getFullYear()!==fromISO(today).getFullYear()?`${d.getFullYear()}년 `:""}${d.getMonth()+1}월 ${d.getDate()}일`;};
  useEffect(()=>{ const o=document.body.style.overflow; document.body.style.overflow="hidden"; return()=>{document.body.style.overflow=o;}; },[]);
  useEffect(()=>{const esc=(e)=>{if(e.key==="Escape")onClose();};document.addEventListener("keydown",esc);return()=>document.removeEventListener("keydown",esc);},[onClose]);

  const byMonth=[]; for(const iso of st.records){const k=iso.slice(0,7);let g=byMonth[byMonth.length-1];if(!g||g.k!==k){g={k,items:[]};byMonth.push(g);}g.items.push(iso);}
  const tile=(label,big,foot,extra)=>(
    <div className="card" style={{padding:"14px 16px",display:"flex",flexDirection:"column",minHeight:112}}>
      <div style={{fontSize:12,color:"var(--sub)"}}>{label}</div>
      <div className="mono" style={{fontSize:26,fontWeight:700,letterSpacing:"-0.02em",margin:"auto 0 4px"}}>{big}</div>
      {extra}
      <div style={{fontSize:12,color:"var(--sub)"}}>{foot}</div>
    </div>
  );
  return(
    <div role="dialog" aria-modal="true" aria-label={`${st.h.name} 기록`} className="sheet">
      <div className="wrap" style={{paddingTop:12}}>
        <div style={{display:"grid",gridTemplateColumns:"36px 1fr 36px",alignItems:"center",gap:12,marginBottom:16}}>
          <button className="btn icon" onClick={onClose} aria-label="뒤로">‹</button>
          <div style={{textAlign:"center",minWidth:0}}>
            <div style={{fontSize:16,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st.h.name}</div>
            <div style={{fontSize:12,color:"var(--sub)",marginTop:2}}>{freqLabel(st.h)}</div>
          </div>
          {isNotion
            ? <a className="btn icon" href={`https://www.notion.so/${String(st.h.id).replace(/-/g,"")}`} aria-label="노션에서 수정"
                target="_blank" rel="noopener noreferrer">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </a>
            : <span/>}
        </div>

        <div className="card" style={{padding:"16px 16px 12px",marginBottom:12}}>
          <Grass cell={st.cell} endISO={endISO} weeks={PAGE_WEEKS} today={today}/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12}}>
            <button className="btn icon" onClick={()=>setPage(p=>Math.min(maxPage,p+1))} disabled={page>=maxPage} aria-label="이전 기간">‹</button>
            <span style={{fontSize:12,color:"var(--sub)"}}>{md(startISO)} — {md(endISO>today?today:endISO)}</span>
            <button className="btn icon" onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} aria-label="다음 기간">›</button>
          </div>
          {st.started&&!st.todayOn&&page===0&&
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginTop:12,paddingTop:12,borderTop:"1px solid var(--line)"}}>
              <span style={{fontSize:13,color:"var(--sub)"}}>오늘 기록 없음</span>
              <button className="btn primary" onClick={onCheckToday}>오늘 체크</button>
            </div>}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:28}}>
          {tile("연속",`${st.cur}${st.unit}`,`최고 ${st.best}${st.unit}`)}
          {tile("총 체크",`${st.total}회`,`시작 ${md(st.startISO)}`)}
          {tile("이번 주",`${Math.min(st.wc,st.t)}/${st.t}`,st.wc>=st.t?"목표 달성":`${st.t-st.wc}회 남음`,
            <div className="bar" style={{marginBottom:8}}><div style={{width:`${st.weekPct*100}%`}}/></div>)}
          {tile("주간 달성률",st.rate==null?"–":`${Math.round(st.rate*100)}%`,st.elig?`최근 ${st.elig}주 중 ${st.ok}주`:"지난 기록 없음")}
        </div>

        <div style={{fontSize:15,fontWeight:700,marginBottom:10}}>기록</div>
        {byMonth.length===0
          ? <div style={{fontSize:13,color:"var(--sub)"}}>아직 체크한 날이 없습니다</div>
          : byMonth.slice(0,6).map(g=>{
              const [y,m]=g.k.split("-");
              return(
                <div key={g.k} style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",margin:"0 2px 6px",fontSize:12,color:"var(--sub)"}}>
                    <span>{y}년 {Number(m)}월</span><span className="mono">{g.items.length}회</span>
                  </div>
                  <div className="card" style={{padding:"0 16px"}}>
                    {g.items.map((iso,i)=>{const d=fromISO(iso);return(
                      <div key={iso} style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:14,
                        borderTop:i?"1px solid var(--line)":"none"}}>
                        <span>{d.getMonth()+1}월 {d.getDate()}일</span>
                        <span style={{color:"var(--sub)"}}>{DAYS[(d.getDay()+6)%7]}요일</span>
                      </div>);})}
                  </div>
                </div>
              );
            })}
      </div>
    </div>
  );
}

/* ── 하루 평점 ── 접힌 상태: 버튼 한 줄 / 펼친 상태: 별 5개 */
function RatingCard({label,score,open,onToggle,onRate}){
  return(
    <div className="card" style={{marginBottom:12,overflow:"hidden"}}>
      <button className="btn rate-head" onClick={onToggle} aria-expanded={open}>
        <span>{label} 하루 평점</span>
        <span style={{display:"flex",alignItems:"center",gap:8}}>
          {open?null:score>0
            ? <span className="mono" style={{color:"var(--acc)",fontWeight:600}}>{"★".repeat(score)}<span style={{color:"var(--cell)"}}>{"★".repeat(5-score)}</span></span>
            : <span style={{color:"var(--sub)"}}>평점 매기기</span>}
          <span aria-hidden="true" style={{color:"var(--sub)",transform:open?"rotate(90deg)":"none",transition:"transform .15s"}}>›</span>
        </span>
      </button>
      {open&&
        <div className="fade" style={{padding:"4px 16px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
          <div role="radiogroup" aria-label={`${label} 하루 평점`} style={{display:"flex",gap:4}}>
            {[1,2,3,4,5].map(n=>(
              <button key={n} role="radio" aria-checked={score===n} aria-label={`${n}점`} className={"btn star"+(n<=score?" on":"")}
                onClick={()=>onRate(n)}>★</button>
            ))}
          </div>
          <div className="mono" style={{fontSize:12,color:"var(--sub)"}}>{score?`${score} / 5 · 같은 별을 누르면 지워요`:"별을 눌러 오늘 하루를 평가하세요"}</div>
        </div>}
    </div>
  );
}

/* ── 레슨런 ── 그날 일하며 배운 점을 한 줄로 남기고, 주차별로 모아 봄 */
function LessonsTab({dateStepper,selDate,dayLabel,today,lessons,note,onAdd,onDelete}){
  const [draft,setDraft]=useState("");
  const [saving,setSaving]=useState(false);
  const save=async()=>{
    const t=draft.trim(); if(!t||saving) return;
    setSaving(true);
    try{ await onAdd(t,selDate); setDraft(""); }catch(e){}
    finally{ setSaving(false); }
  };
  /* 주차별 묶음 (최신 주가 위) */
  const groups=[];
  for(const l of [...lessons].sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)){
    const k=toISO(mondayOf(fromISO(l.date)));
    let g=groups[groups.length-1]; if(!g||g.k!==k){g={k,items:[]};groups.push(g);} g.items.push(l);
  }
  const curK=toISO(mondayOf(fromISO(today)));
  return(
    <div className="fade">
      {dateStepper}
      <div className="card" style={{padding:"10px 14px 12px",marginBottom:12}}>
        <textarea className="ta" rows={3} maxLength={500} value={draft} onChange={e=>setDraft(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();save();}}}
          placeholder="배운 점, 다음에 다르게 할 점을 한 줄로" aria-label="레슨런 내용"/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:6}}>
          <span style={{fontSize:12,color:"var(--sub)"}}>{dayLabel} 레슨런으로 저장</span>
          <button className="btn primary" disabled={!draft.trim()||saving} onClick={save}>{saving?"저장 중…":"저장"}</button>
        </div>
      </div>
      {note&&<div className="notice" style={{marginTop:0,marginBottom:12}}>{note}</div>}
      {groups.length===0
        ? <div style={{fontSize:13,color:"var(--sub)",textAlign:"center",padding:"24px 0"}}>아직 레슨런이 없어요</div>
        : groups.map(g=>{const wk=weekOfMonth(g.k);return(
            <div key={g.k} style={{marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",margin:"0 2px 6px",fontSize:12,color:"var(--sub)"}}>
                <span>{g.k===curK?"이번 주":`${wk.m}월 ${wk.w}주차`}</span><span className="mono">{g.items.length}개</span>
              </div>
              <div className="card" style={{padding:"0 4px 0 16px"}}>
                {g.items.map((l,i)=>{const d=fromISO(l.date);return(
                  <div key={l.id} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 0",borderTop:i?"1px solid var(--line)":"none"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,lineHeight:1.55,whiteSpace:"pre-wrap",wordBreak:"keep-all"}}>{l.text}</div>
                      <div className="mono" style={{fontSize:12,color:"var(--sub)",marginTop:3}}>{d.getMonth()+1}월 {d.getDate()}일 ({DAYS[(d.getDay()+6)%7]})</div>
                    </div>
                    <button className="btn del" aria-label="삭제" onClick={()=>{if(window.confirm("이 레슨런을 삭제할까요?"))onDelete(l.id);}}>×</button>
                  </div>);})}
              </div>
            </div>);})}
    </div>
  );
}

const CSS=`
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');
  :root{
    --bg:#F6F7F9;--surface:#FFFFFF;--ink:#16181D;--sub:#6B7280;--line:#E7E9EE;
    --acc:#2F6FEB;--acc-rgb:47,111,235;--on-acc:#FFFFFF;--neg:#C2410C;
    --cell:#ECEEF2;--cell-pre:#F4F5F7;--notice-bg:#FFF7E6;--notice-ink:#8A5A00;
    color-scheme:light;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0F1115;--surface:#171A21;--ink:#E7E9EE;--sub:#9097A3;--line:#262A33;
    --acc:#5B8DEF;--acc-rgb:91,141,239;--on-acc:#0B1020;--neg:#F0915A;
    --cell:#222630;--cell-pre:#1A1D24;--notice-bg:#2A2313;--notice-ink:#E8C879;
    color-scheme:dark;
  }}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);max-width:100%;overflow-x:clip}
  .app{min-height:100vh;color:var(--ink);font-family:'Pretendard',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .mono{font-variant-numeric:tabular-nums}
  button,input,select{font-family:inherit}
  .wrap{max-width:560px;margin:0 auto;padding:0 16px 64px}
  .navbar{position:sticky;top:0;z-index:10;background:var(--bg);padding:14px 0 12px;margin-bottom:4px}
  .notice{margin-top:10px;background:var(--notice-bg);color:var(--notice-ink);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px}
  .btn{cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .15s,opacity .15s}
  .btn:disabled{opacity:.35;cursor:default}
  .btn.icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--line);
    border-radius:10px;background:var(--surface);color:var(--ink);font-size:18px;line-height:1;text-decoration:none}
  .btn.primary{background:var(--acc);color:var(--on-acc);border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600}
  .ta{width:100%;resize:none;line-height:1.6;font-size:15px;border:none;background:transparent;padding:4px 2px}
  .lessons-mini{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
  .lessons-mini li{display:flex;gap:10px;font-size:14px;line-height:1.5;word-break:keep-all;white-space:pre-wrap}
  .lessons-mini li span{color:var(--sub);font-size:12px;flex:0 0 auto;padding-top:2px}
  .rate-head{display:flex;align-items:center;justify-content:space-between;width:100%;gap:12px;padding:14px 16px;
    background:none;border:none;color:var(--ink);font-size:13px;text-align:left}
  .btn.star{border:none;background:none;padding:2px 4px;font-size:34px;line-height:1;color:var(--cell);transition:color .12s,transform .12s}
  .btn.star.on{color:var(--acc)}
  .btn.star:active{transform:scale(.9)}
  .btn.del{border:none;background:none;color:var(--sub);font-size:18px;line-height:1;width:32px;height:32px;flex:0 0 auto;border-radius:8px}
  .btn.del:hover{background:var(--cell)}
  .link{background:none;border:none;padding:4px;color:var(--sub);font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
  .seg{display:flex;gap:2px;padding:3px;border-radius:10px;background:var(--cell)}
  .seg .btn{border:none;background:transparent;color:var(--sub);padding:6px 12px;border-radius:8px;font-size:14px;font-weight:600}
  .seg .btn.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
  .row{display:flex;align-items:center;gap:12px;padding:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;font-family:inherit}
  .row:hover{background:rgba(var(--acc-rgb),.04)}
  .row:focus-visible,.btn:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
  .chk{width:22px;height:22px;border-radius:6px;flex:0 0 auto;border:1.5px solid var(--sub);display:flex;align-items:center;
    justify-content:center;color:var(--on-acc);font-size:13px;font-weight:700;transition:background .12s,border-color .12s}
  .chk.on{background:var(--acc);border-color:var(--acc)}
  .bar{height:6px;border-radius:3px;background:var(--cell);overflow:hidden}
  .bar>div{height:100%;background:var(--acc);border-radius:3px;transition:width .3s ease}
  .kv{display:flex;flex-direction:column;border-top:1px solid var(--line)}
  .kv>div{display:flex;justify-content:space-between;gap:12px;padding:10px 0 0;font-size:13px}
  .kv span{color:var(--sub)}
  .lg{display:inline-block;width:14px;height:2px;border-radius:1px}
  .lg.dash{background:repeating-linear-gradient(90deg,var(--sub) 0 4px,transparent 4px 7px)}
  .tip{position:absolute;top:0;z-index:2;pointer-events:none;white-space:nowrap;background:var(--surface);border:1px solid var(--line);
    border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;box-shadow:0 4px 16px rgba(0,0,0,.12)}
  .sheet{position:fixed;inset:0;z-index:90;overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--bg)}
  .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:100;max-width:min(92vw,420px);
    background:var(--ink);color:var(--bg);border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.5}
  .sk{border-radius:12px;background:var(--cell);animation:sk 1.4s ease-in-out infinite}
  @keyframes sk{0%,100%{opacity:1}50%{opacity:.55}}
  .fade{animation:fade .2s ease}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  @media(prefers-reduced-motion:reduce){.fade,.sk{animation:none}}
`;
