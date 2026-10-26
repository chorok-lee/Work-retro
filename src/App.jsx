import React, { useState, useEffect, useMemo, useRef } from "react";
import { extractTags } from "../api/_keywords.js";

/* ────────────────────────────────────────────────────────────
   업무 회고 — 개인 업무 루틴 트래커
   할 일(업무 루틴)마다 주간 목표 횟수를 두고, 날짜별로 체크합니다.
   [오늘] 탭: 오늘 할 일(노션 과업 DB, 마감일 = 그날) · 매일 루틴 체크 · 하루 평점
   [레슨런] 탭: 그날 배운 점 한 줄
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

/* 한 주 = 평일 5일. 매일 = 주 5회, 주 6~7회로 적힌 것도 5회로 봅니다 */
const WORKDAYS=5;
const tgtOf = (h) => h.kind==="daily" ? WORKDAYS : Math.min(WORKDAYS,h.target);
const freqLabel = (h) => tgtOf(h)>=WORKDAYS ? "매일" : `주 ${tgtOf(h)}회`;
/* 매일 → 주 1회 순으로, 같은 주기면 가나다순 */
const sortItems = (list) => [...(list||[])].sort((a,b)=>{
  const ta=tgtOf(a), tb=tgtOf(b);
  if(ta!==tb) return tb-ta;
  return String(a.name||"").localeCompare(String(b.name||""),"ko");
});

const toISO=(d)=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`;};
const fromISO=(s)=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const mondayOf=(d)=>{const x=new Date(d);x.setDate(x.getDate()-((x.getDay()+6)%7));return x;};
/* 한 주의 평일(월~금) 날짜. 토·일 기록은 세지 않습니다 */
const weekDatesFrom=(mon)=>Array.from({length:WORKDAYS},(_,i)=>toISO(addDays(mon,i)));
const DAYS=["월","화","수","목","금"];
const WD7=["월","화","수","목","금","토","일"];   // 날짜 표시용
const wdOf=(iso)=>WD7[(fromISO(iso).getDay()+6)%7];
const isWorkday=(iso)=>{const g=fromISO(iso).getDay();return g!==0&&g!==6;};
/* 주말이면 앞뒤 평일로 */
const prevWorkday=(iso)=>{let d=addDays(fromISO(iso),-1);while(!isWorkday(toISO(d)))d=addDays(d,-1);return toISO(d);};
const nextWorkday=(iso)=>{let d=addDays(fromISO(iso),1);while(!isWorkday(toISO(d)))d=addDays(d,1);return toISO(d);};
const lastWorkday=(iso)=>isWorkday(iso)?iso:prevWorkday(iso);
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
  const [selDate,setSelDate]=useState(()=>lastWorkday(toISO(new Date())));
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
  /* 오늘 할 일 { "YYYY-MM-DD": [task] } — 노션 과업 DB에서 마감일이 그날인 것.
     앱에서 바꾸면 바로 노션에 저장, 노션에서 바꾼 건 앱 복귀 시·1분마다 다시 불러와 반영 */
  const [tasks,setTasks]=useState({});
  const [tasksErr,setTasksErr]=useState("");
  const [tasksDb,setTasksDb]=useState("");
  const taskWriteAt=useRef(0);   // 쓰기 이후에 시작되지 않은 조회 결과는 버림(방금 바꾼 값이 되돌아가지 않도록)
  const syncModeRef=useRef("loading");
  const selDateRef=useRef(null);

  /* 저녁 6시~자정에는 평점 모듈을 펼쳐 둡니다 — 시각이 바뀌는 걸 1분마다 확인 */
  const [hour,setHour]=useState(()=>new Date().getHours());
  useEffect(()=>{const t=setInterval(()=>setHour(new Date().getHours()),60000);return()=>clearInterval(t);},[]);

  /* 화면 이동 — 회고 하위 화면 #review/<이름>, 루틴 상세 #item/<id>. 폰의 뒤로가기로 닫힘 */
  const parseHash=()=>{const h=window.location.hash||"";const a=h.match(/^#item\/(.+)$/),b=h.match(/^#review\/(\w+)$/);
    return {item:a?decodeURIComponent(a[1]):null,sub:b?b[1]:null};};
  const [detailId,setDetailId]=useState(()=>parseHash().item);
  const [subView,setSubView]=useState(()=>parseHash().sub);
  const pushed=useRef(0);   // 이 앱이 쌓은 기록 수 — 그만큼은 history.back()으로 닫음
  useEffect(()=>{
    const on=()=>{const {item,sub}=parseHash();pushed.current=Math.max(0,pushed.current-1);
      setDetailId(item);setSubView(prev=>sub??(item?prev:null));};
    window.addEventListener("popstate",on);return()=>window.removeEventListener("popstate",on);
  },[]);
  const base=()=>window.location.pathname+window.location.search;
  const openSub=(name)=>{window.history.pushState({s:1},"",`#review/${name}`);pushed.current++;setSubView(name);};
  const openDetail=(id)=>{window.history.pushState({d:1},"",`#item/${encodeURIComponent(id)}`);pushed.current++;setDetailId(id);};
  const goBack=()=>{
    if(pushed.current>0){window.history.back();return;}
    if(detailId){setDetailId(null);window.history.replaceState(null,"",subView?`#review/${subView}`:base());}
    else{setSubView(null);window.history.replaceState(null,"",base());}
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
      throw new Error("노션에서 가져온 루틴이 없어요. '활성' 체크가 켜진 루틴이 있는지 확인해주세요.");
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

  const loadTasks=async(date,mode=syncModeRef.current)=>{
    if(!date) return;
    if(mode==="local"){
      try{const all=JSON.parse(LS.get("wr_tasks")||"{}");setTasks(all&&typeof all==="object"?all:{});}catch{setTasks({});}
      return;
    }
    if(mode!=="notion") return;
    const started=Date.now();
    try{
      const r=await api(`/api/tasks?date=${date}`);
      if(taskWriteAt.current>=started) return;
      setTasks(p=>({...p,[date]:Array.isArray(r?.tasks)?r.tasks:[]}));
      setTasksErr("");
      if(r?.tasksDb) setTasksDb(r.tasksDb);
    }catch(e){ setTasksErr(e.message||"할 일을 불러오지 못했어요."); }
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
      loadTasks(selDateRef.current,"notion");
    }
    catch(e){
      if(sync.mode==="notion") setStaleWarn("노션에 연결하지 못해 마지막으로 불러온 기록을 보여주고 있어요.");
      else { loadFromLocal(); loadLessonsLocal(""); loadRatingsLocal(); loadTasks(selDateRef.current,"local"); setSync({mode:"local",error:e.message||"노션에 연결하지 못했어요."}); }
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
  useEffect(()=>{if(sync.mode==="local")LS.set("wr_tasks",JSON.stringify(tasks));},[tasks,sync.mode]);
  syncModeRef.current=sync.mode; selDateRef.current=selDate;
  /* 날짜를 옮기면 그날 할 일을, 화면을 켜 둔 동안엔 1분마다 다시 불러옴 */
  useEffect(()=>{if(sync.mode==="notion")loadTasks(selDate);},[selDate,sync.mode]);
  useEffect(()=>{
    const t=setInterval(()=>{if(document.visibilityState==="visible")loadTasks(selDateRef.current);},60000);
    return()=>clearInterval(t);
  },[]);
  useEffect(()=>{
    if(!loaded||sync.mode!=="notion"||!resRef.current)return;
    LS.set(CACHE_KEY,JSON.stringify({res:resRef.current,logs,lessons:lessonMode==="notion"?lessons:undefined,
      ratings:ratingMode==="notion"?ratings:undefined,savedAt:Date.now()}));
  },[items,logs,lessons,lessonMode,ratings,ratingMode,loaded,sync.mode]);

  const today=toISO(new Date());
  const workToday=lastWorkday(today);   // 주말엔 직전 금요일
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
    const tmp={id:"tmp"+Date.now(),date,text,tags:extractTags(text)};
    setLessons(p=>[tmp,...p]);
    if(lessonMode!=="notion"){setLessons(p=>p.map(l=>l.id===tmp.id?{...l,id:"l"+Date.now()}:l));return;}
    try{
      const r=await api("/api/lessons",{method:"POST",body:JSON.stringify({text,date})});
      setLessons(p=>p.map(l=>l.id===tmp.id?{...l,id:r.id,tags:Array.isArray(r.tags)?r.tags:l.tags}:l));
    }catch(e){
      setLessons(p=>p.filter(l=>l.id!==tmp.id));
      setToast(e.message||"레슨런을 저장하지 못했어요.");
      throw e;
    }
  };
  /* 하루 평점 — 같은 별을 다시 누르면 지움(0) */
  /* 오늘 할 일 추가·수정 — 화면 먼저 바꾸고 노션에 저장, 실패하면 되돌림 */
  const addTask=async(title)=>{
    const date=selDate, tmp={id:"tmp"+Date.now(),title,done:false,priority:"",url:""};
    taskWriteAt.current=Date.now();
    setTasks(p=>({...p,[date]:[...(p[date]||[]),tmp]}));
    if(sync.mode!=="notion") return;
    try{
      const r=await api("/api/tasks",{method:"POST",body:JSON.stringify({title,date})});
      setTasks(p=>({...p,[date]:(p[date]||[]).map(t=>t.id===tmp.id?r.task:t)}));
    }catch(e){
      setTasks(p=>({...p,[date]:(p[date]||[]).filter(t=>t.id!==tmp.id)}));
      setToast(e.message||"할 일을 추가하지 못했어요.");
    }finally{ taskWriteAt.current=Date.now(); }
  };
  const patchTask=async(id,patch)=>{
    const date=selDate, prev=(tasks[date]||[]).find(t=>t.id===id); if(!prev) return;
    taskWriteAt.current=Date.now();
    setTasks(p=>({...p,[date]:(p[date]||[]).map(t=>t.id===id?{...t,...patch}:t)}));
    if(sync.mode!=="notion"||String(id).startsWith("tmp")) return;
    try{ await api("/api/tasks",{method:"PATCH",body:JSON.stringify({id,...patch})}); }
    catch(e){
      setTasks(p=>({...p,[date]:(p[date]||[]).map(t=>t.id===id?prev:t)}));
      setToast(e.message||"노션에 저장하지 못했어요.");
    }finally{ taskWriteAt.current=Date.now(); }
  };

  const setRating=async(date,score)=>{
    const prev=ratings[date]||0;
    const apply=(v)=>setRatings(p=>{const o={...p};if(v)o[date]=v;else delete o[date];return o;});
    apply(score);
    if(ratingMode!=="notion") return;
    try{ await api("/api/ratings",{method:"PUT",body:JSON.stringify({date,score})}); }
    catch(e){ apply(prev); setToast(e.message||"평점을 저장하지 못했어요."); }
  };
  const editLesson=async(id,text)=>{
    const prev=lessons.find(l=>l.id===id); if(!prev||prev.text===text) return;
    setLessons(p=>p.map(l=>l.id===id?{...l,text,tags:extractTags(text)}:l));
    if(lessonMode!=="notion"||String(id).startsWith("tmp")) return;
    try{
      const r=await api("/api/lessons",{method:"PATCH",body:JSON.stringify({id,text})});
      if(Array.isArray(r?.tags)) setLessons(p=>p.map(l=>l.id===id?{...l,tags:r.tags}:l));
    }
    catch(e){ setLessons(p=>p.map(l=>l.id===id?prev:l)); setToast(e.message||"수정하지 못했어요."); }
  };
  /* 하루 평가 제출 — 별점과 레슨런을 함께 저장하고 카드를 접음 */
  const submitDay=async(score,text)=>{
    const date=selDate;
    if(score!==(ratings[date]||0)) await setRating(date,score);
    if(text) await addLesson(text,date);   // 실패하면 여기서 멈추고 카드는 열린 채로
    setRatingToggle(t=>({...t,[date]:false}));
    setToast("제출했어요");
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
    const todayIdx=Math.min(WORKDAYS-1,(fromISO(today).getDay()+6)%7);   // 주말이면 금요일까지
    const dayCount=(iso)=>list.reduce((n,h)=>n+(isLogged(h.id,iso)?1:0),0);
    const cumul=(mon)=>{let c=0;return weekDatesFrom(mon).map(d=>(c+=dayCount(d)));};
    const cur=cumul(curMon), prev=cumul(addDays(curMon,-7));
    const now=cur[todayIdx], then=prev[todayIdx];
    const curWeek=weekDatesFrom(curMon);
    const left=(h)=>tgtOf(h)-curWeek.reduce((n,d)=>n+(isLogged(h.id,d)?1:0),0);
    /* 이 속도면 채울 수 있는 목표 수 */
    const onTrack=list.filter(h=>{const wc=tgtOf(h)-left(h);return wc/(todayIdx+1)*WORKDAYS>=tgtOf(h);}).length;
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
    const t=tgtOf(h), daily=t>=WORKDAYS;
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
    const days=[]; for(let d=fromISO(startISO>yearAgo?startISO:yearAgo);toISO(d)<=today;d=addDays(d,1)) if(isWorkday(toISO(d))) days.push(toISO(d));
    const logged=days.filter(d=>isLogged(h.id,d));
    let cur=0,best=0;
    if(daily){
      let run=0; for(const d of days){ run=isLogged(h.id,d)?run+1:0; best=Math.max(best,run); }
      let i=days.length-1; if(i>=0&&days[i]===today&&!isLogged(h.id,days[i])) i--;   // 오늘 아직이면 직전 평일부터
      while(i>=0&&isLogged(h.id,days[i])){cur++;i--;}
    }else{
      const mons=[]; for(let m=mondayOf(fromISO(days[0]||today));toISO(m)<=today;m=addDays(m,7)) mons.push(m);
      let run=0; for(const m of mons){ run=cntOf(m)>=t?run+1:0; best=Math.max(best,run); }
      let i=mons.length-1; if(i>=0&&cntOf(mons[i])<t) i--;                 // 이번 주 진행 중이면 지난주부터
      while(i>=0&&cntOf(mons[i])>=t){cur++;i--;}
    }
    const wc=cntOf(curMon);
    /* 최근 12주(이번 주 제외, 시작 이후) 중 목표를 채운 주 */
    let ok=0,elig=0; for(let i=1;i<=12;i++){const m=addDays(curMon,-7*i); if(toISO(addDays(m,WORKDAYS-1))<startISO) continue; elig++; if(cntOf(m)>=t) ok++;}
    return {h,t,daily,unit:daily?"일":"주",cell,cur,best,total:logged.length,startISO,
      wc,weekPct:Math.min(1,wc/t),ok,elig,rate:elig?ok/elig:null,
      records:[...logged].reverse(),todayOn:isLogged(h.id,today),started:startISO<=today};
  };

  /* 하루 평가: 평소엔 할 일 목록 아래 접힌 박스.
     오늘 저녁 6시~자정에는 진행 카드 바로 아래로 올라와 펼쳐짐 (워킹아워 끝나고 잊지 않도록).
     직접 접거나 펼치면 그 날짜에선 그 선택을 따름 */
  const [ratingToggle,setRatingToggle]=useState({});   // { date: true|false }
  const evening=selDate===today&&hour>=18;
  const ratingOpen=ratingToggle[selDate]??evening;
  const ratingCard=(
    <RatingCard key={selDate} score={ratings[selDate]||0} open={ratingOpen}
      lessonCount={lessons.filter(l=>l.date===selDate).length}
      onToggle={()=>setRatingToggle(t=>({...t,[selDate]:!ratingOpen}))}
      onSubmit={submitDay}/>
  );

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

  /* 내비게이션 — iOS처럼 큰 제목 + 위쪽 막대(스크롤하면 작은 제목) + 아래 탭 막대 */
  const [scrolled,setScrolled]=useState(false);
  useEffect(()=>{const on=()=>setScrolled(window.scrollY>44);on();window.addEventListener("scroll",on,{passive:true});return()=>window.removeEventListener("scroll",on);},[]);
  const title=tab==="todo"?(selDate===today?"오늘":`${selD.getMonth()+1}월 ${selD.getDate()}일`):"회고";
  const fullDate=`${selD.getMonth()+1}월 ${selD.getDate()}일 ${wdOf(selDate)}요일`;
  const curWk=weekOfMonth(toISO(curMon));
  const subtitle=tab==="todo"?(selDate===today?fullDate:`${wdOf(selDate)}요일`):`${curWk.m}월 ${curWk.w}주차`;
  const dayNav=tab==="todo"&&(
    <div className="nav-actions">
      {selDate!==workToday&&<button className="btn txt" onClick={()=>setSelDate(workToday)}>{workToday===today?"오늘":"최근 평일"}</button>}
      <button className="btn nav-ico" aria-label="이전 평일" onClick={()=>setSelDate(prevWorkday(selDate))}><Chevron dir="l"/></button>
      <button className="btn nav-ico" aria-label="다음 평일" disabled={nextWorkday(selDate)>today}
        onClick={()=>{const n=nextWorkday(selDate);if(n<=today)setSelDate(n);}}><Chevron dir="r"/></button>
    </div>
  );
  const dbLink=(id)=>id?`https://www.notion.so/${String(id).replace(/-/g,"")}`:"";

  /* 회고 요약 카드에 들어갈 이번 주 숫자 */
  const thisWeek=weekDatesFrom(curMon);
  const pace=paceOf(list);
  const dayChecks=thisWeek.map(d=>d>today?null:list.filter(h=>isLogged(h.id,d)).length);
  const weekRatings=thisWeek.map(d=>d>today?null:(ratings[d]||0));
  const rated=weekRatings.filter(v=>v);
  const ratingAvg=rated.length?(rated.reduce((a,b)=>a+b,0)/rated.length):null;
  const latestLesson=[...lessons].sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)[0];
  const shortDate=(iso)=>iso===today?"오늘":`${fromISO(iso).getMonth()+1}월 ${fromISO(iso).getDate()}일`;

  return (
    <div className="app">
      <style>{CSS}</style>
      <header className={"navbar"+(scrolled?" scrolled":"")}>
        <div className="navbar-in">
          <span/>
          <span className="nav-title" aria-hidden={!scrolled}>{title}</span>
          <div style={{justifySelf:"end"}}>{dayNav}</div>
        </div>
      </header>

      <main className="wrap">
        <h1 className="large-title">{title}</h1>
        <p className="subtitle">{subtitle}</p>
        {notice&&<div className="banner" role="status">{notice}</div>}

        {booting&&<LoadingView/>}

        {!booting&&tab==="todo"&&(
          <div className="fade">
            {evening&&<div style={{marginTop:18}}>{ratingCard}</div>}

            {/* 오늘 할 일 — 그날 마감인 구체적인 과업 (노션 과업 DB와 동기화) */}
            <TasksSection title="할 일" tasks={tasks[selDate]||[]} err={isNotion?tasksErr:""} onAdd={addTask}
              dbUrl={isNotion?dbLink(tasksDb):""}
              onToggle={(t)=>patchTask(t.id,{done:!t.done})} onRename={(t,title)=>patchTask(t.id,{title})}/>

            {/* 매일 루틴 — 생산성을 위해 매일 지키는 습관 */}
            {list.length>0&&
              <section className="group">
                <div className="group-head">
                  <h2>매일 루틴</h2>
                  <span className="group-side">
                    <span className="num">{dayDone}/{list.length}</span>
                    {/* 루틴 추가·수정은 노션 DB에서 */}
                    {itemsDb&&<a className="btn txt" href={dbLink(itemsDb)} target="_blank" rel="noopener noreferrer">관리하기</a>}
                  </span>
                </div>
                <div className="cells">
                  {list.map(h=>{
                    const on=isLogged(h.id,selDate),wc=weekCount(h.id),t=tgtOf(h);
                    return(
                      <div key={h.id} className="cell tap" role="checkbox" aria-checked={on} tabIndex={0}
                        onClick={()=>toggleLog(h.id,selDate)}
                        onKeyDown={e=>{if(e.key===" "||e.key==="Enter"){e.preventDefault();toggleLog(h.id,selDate);}}}>
                        <CheckBox on={on}/>
                        <div className="cell-body">
                          <div className="cell-main">
                            <div className={"cell-title"+(on?" done":"")}>{h.name}</div>
                            <div className="cell-sub">{freqLabel(h)}</div>
                          </div>
                          <span className={"cell-value num"+(wc>=t?" met":"")}>{Math.min(wc,t)}/{t}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="group-foot">오른쪽 숫자는 이번 주에 체크한 횟수예요.</p>
              </section>}

            {!evening&&<div style={{marginTop:26}}>{ratingCard}</div>}
          </div>
        )}

        {!booting&&tab==="review"&&(
          <div className="fade summary">
            <SummaryCard icon="check" color="var(--blue)" title="루틴" meta="이번 주" onOpen={()=>openSub("routine")}
              value={pace?pace.now:0} unit="회" bars={dayChecks} max={Math.max(list.length,1)}/>
            <SummaryCard icon="star" color="var(--orange)" title="하루 평점" meta="이번 주" onOpen={()=>openSub("rating")}
              value={ratingAvg==null?null:ratingAvg.toFixed(1)} unit="점" empty="아직 없어요" bars={weekRatings} max={5}/>
            <SummaryCard icon="bulb" color="var(--purple)" title="레슨런" meta={latestLesson?shortDate(latestLesson.date):""} onOpen={()=>openSub("lessons")}
              empty={latestLesson?null:"아직 없어요"} quote={latestLesson?.text}
              foot={thisWeekLessons.length?`이번 주에 ${thisWeekLessons.length}개 남겼어요`:"이번 주에는 아직 없어요"}/>
          </div>
        )}
      </main>

      <nav className="tabbar" role="tablist" aria-label="화면">
        {[["todo","오늘","check"],["review","회고","chart"]].map(([k,l,ic])=>(
          <button key={k} role="tab" aria-selected={tab===k} className={"btn tab"+(tab===k?" on":"")}
            onClick={()=>{setTab(k);window.scrollTo({top:0});}}>
            <Icon name={ic} size={25}/><span>{l}</span>
          </button>
        ))}
      </nav>

      {subView==="routine"&&
        <SubPage title="루틴" onBack={goBack}>
          <PaceCard p={pace}/>
          {list.length>0&&
            <section className="group">
              <div className="group-head small"><h2>최근 3주 루틴 기록</h2></div>
              <div className="cells">
                {list.map(h=><ItemRow key={h.id} st={itemStats(h)} today={today} onOpen={()=>openDetail(h.id)}/>)}
              </div>
            </section>}
        </SubPage>}
      {subView==="rating"&&
        <SubPage title="하루 평점" onBack={goBack}>
          <RatingTrend ratings={ratings} today={today}/>
          <RatingHistory ratings={ratings} today={today}/>
        </SubPage>}
      {subView==="lessons"&&
        <SubPage title="레슨런" onBack={goBack}>
          {lessonNote&&<div className="banner">{lessonNote}</div>}
          <LessonsList lessons={lessons} today={today} onEdit={editLesson} onDelete={delLesson}/>
        </SubPage>}
      {detailItem&&<ItemDetail st={itemStats(detailItem)} today={today} isNotion={isNotion}
        backLabel={subView==="routine"?"루틴":"회고"} onClose={goBack}/>}
      {toast&&<div className="toast fade" role="status">{toast}</div>}
    </div>
  );
}

/* ── 회고 하위 화면 — 푸시된 화면처럼 왼쪽 위 '‹ 회고' ── */
function SubPage({title,onBack,children}){
  useEffect(()=>{const esc=(e)=>{if(e.key==="Escape")onBack();};document.addEventListener("keydown",esc);return()=>document.removeEventListener("keydown",esc);},[onBack]);
  return(
    <div role="dialog" aria-modal="true" aria-label={title} className="sheet push" style={{zIndex:80}}>
      <header className="navbar scrolled">
        <div className="navbar-in">
          <button className="btn glass-ico" onClick={onBack} aria-label="회고로 돌아가기"><Chevron dir="l" size={20}/></button>
          <span className="nav-title">{title}</span>
          <span/>
        </div>
      </header>
      <div className="wrap" style={{paddingTop:6}}>{children}</div>
    </div>
  );
}

/* ── 회고 요약 카드 (건강 앱 요약처럼) — 제목·시점 | 큰 값 + 작은 막대 ── */
function SummaryCard({icon,color,title,meta,onOpen,value,unit,empty,bars,max,quote,foot}){
  return(
    <button className="btn sum-card" onClick={onOpen} aria-label={`${title} 자세히 보기`}>
      <div className="sum-head">
        <span className="sum-title" style={{color}}><Icon name={icon} size={19}/>{title}</span>
        <span className="sum-meta">{meta}<Chevron size={15}/></span>
      </div>
      <div className="sum-body">
        <div style={{minWidth:0,flex:1}}>
          {quote&&<p className="sum-quote">{quote}</p>}
          {value!=null
            ? <div className="sum-value"><span className="num">{value}</span>{unit&&<small>{unit}</small>}</div>
            : empty&&<div className="sum-empty">{empty}</div>}
          {foot&&<div className="sum-foot">{foot}</div>}
        </div>
        {bars&&
          <svg className="sum-bars" viewBox="0 0 96 56" width="96" height="56" aria-hidden="true">
            {bars.map((v,i)=>{const h=v==null?0:Math.max(4,52*v/max);
              return <rect key={i} x={i*20+1} y={56-h} width="14" height={h} rx="2.5" fill="var(--gray4)"/>;})}
          </svg>}
      </div>
    </button>
  );
}

/* 하루 평점 목록 — 최근 평가한 날 */
function RatingHistory({ratings,today}){
  const days=Object.keys(ratings).filter(d=>d<=today&&ratings[d]).sort().reverse().slice(0,20);
  if(!days.length) return <p className="group-foot" style={{marginTop:20}}>아직 평가한 날이 없어요. 오늘 탭의 하루 평가하기에서 남길 수 있어요.</p>;
  return(
    <section className="group">
      <div className="group-head small"><h2>지난 평가</h2></div>
      <div className="cells">
        {days.map(d=>{const x=fromISO(d);return(
          <div key={d} className="cell"><div className="cell-body">
            <span className="cell-title">{x.getMonth()+1}월 {x.getDate()}일 <span style={{color:"var(--label2)"}}>{wdOf(d)}요일</span></span>
            <Stars n={ratings[d]} size={15}/>
          </div></div>);})}
      </div>
    </section>
  );
}

/* ── 아이콘 — SF Symbols 느낌의 단순한 선 아이콘 ── */
function Icon({name,size=22}){
  const p={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true};
  if(name==="check") return <svg {...p}><circle cx="5" cy="6.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.6" fill="currentColor" stroke="none"/><path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/></svg>;
  if(name==="bulb") return <svg {...p}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>;
  if(name==="chart") return <svg {...p}><path d="M5 20V12M10 20V5M15 20v-9M20 20V8"/></svg>;
  if(name==="flame") return <svg {...p}><path d="M12 21c3.9 0 6.5-2.7 6.5-6.4 0-3.3-2.3-5.6-3.8-7.6-.4 1.9-1.5 3-2.7 3.5.2-2.8-1-5.4-3.4-7.5-.3 3.5-4.1 6.2-4.1 11.6C4.5 18.3 7.6 21 12 21z"/></svg>;
  if(name==="star") return <svg {...p} fill="currentColor" stroke="none"><path d={STAR}/></svg>;
  return null;
}
function Chevron({dir="r",size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir==="l"?"M15 5l-7 7 7 7":"M9 5l7 7-7 7"}/></svg>;
}
/* 체크박스 — 둥근 네모, 체크하면 파랑 채움 + 흰 체크 */
function CheckBox({on}){
  return <span className={"cbox"+(on?" on":"")} aria-hidden="true">
    {on&&<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7.3 5.8 10 11 4.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
  </span>;
}

/* ── 로딩: 실제 화면과 같은 자리의 뼈대 ── */
function LoadingView(){
  return(
    <div className="fade" role="status" aria-label="불러오는 중">
      <div className="sk" style={{height:22,width:90,margin:"26px 16px 10px"}}/>
      <div className="sk" style={{height:180,borderRadius:10}}/>
      <div className="sk" style={{height:22,width:110,margin:"30px 16px 10px"}}/>
      <div className="sk" style={{height:240,borderRadius:10}}/>
    </div>
  );
}

/* ── 루틴 체크 요약 (건강 앱 요약 카드처럼) ──
   이번 주 누적 체크와 지난주 같은 요일까지의 누적 비교 (지난주 점선 / 이번 주 실선) */
function PaceCard({p}){
  const [hi,setHi]=useState(null);
  if(!p) return null;
  const {todayIdx,cur,prev,now}=p;
  const W=560,H=96,PX=10,PT=10,PB=6;
  const last=DAYS.length-1;
  const max=Math.max(prev[last],now,1);
  const X=(i)=>PX+(W-PX*2)*i/last, Y=(v)=>PT+(H-PT-PB)*(1-v/max);
  const pts=(arr,n)=>arr.slice(0,n).map((v,i)=>`${X(i)},${Y(v)}`).join(" ");
  const pick=(e)=>{const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width*W;
    setHi(Math.max(0,Math.min(last,Math.round((x-PX)/((W-PX*2)/last)))));};
  return(<>
    <div className="card" style={{marginTop:8}}>
      <div className="card-head" style={{color:"var(--blue)"}}><Icon name="check" size={17}/>이번 주 체크</div>
      <div className="value"><span className="num">{now}</span><small>회</small></div>
      <div style={{position:"relative",marginTop:14}} onPointerMove={pick} onPointerDown={pick}
        onPointerLeave={e=>{if(e.pointerType==="mouse")setHi(null);}}>
        {hi!=null&&
          <div className="tip" style={{left:`${X(hi)/W*100}%`,transform:`translate(${hi<=0?"-8%":hi>=last?"-92%":"-50%"},-100%)`}}>
            <div style={{fontWeight:600}}>{DAYS[hi]}요일까지</div>
            <div>이번 주 <b className="num">{hi<=todayIdx?`${cur[hi]}회`:"–"}</b></div>
            <div style={{color:"var(--label2)"}}>지난주 <span className="num">{prev[hi]}회</span></div>
          </div>}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{display:"block",overflow:"visible",touchAction:"pan-y"}} aria-hidden="true">
          {[0,.5,1].map(f=><line key={f} x1={PX} x2={W-PX} y1={Y(max*f)} y2={Y(max*f)} stroke="var(--sep)" strokeWidth="1"/>)}
          {hi!=null&&<line x1={X(hi)} x2={X(hi)} y1={PT-6} y2={H-PB+2} stroke="var(--label3)" strokeWidth="1"/>}
          <polyline points={pts(prev,DAYS.length)} fill="none" stroke="var(--gray2)" strokeWidth="2" strokeDasharray="4 5" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points={pts(cur,todayIdx+1)} fill="none" stroke="var(--blue)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          {hi!=null&&<circle cx={X(hi)} cy={Y(prev[hi])} r="4" fill="var(--gray2)"/>}
          {hi!=null&&hi<todayIdx&&<circle cx={X(hi)} cy={Y(cur[hi])} r="4" fill="var(--blue)"/>}
          <circle cx={X(todayIdx)} cy={Y(now)} r="5.5" fill="var(--blue)" stroke="var(--cell)" strokeWidth="2.5"/>
        </svg>
      </div>
      <div className="axis" style={{padding:`6px ${PX/W*100}% 0`}}>
        {DAYS.map((d,i)=><span key={d} className={i===todayIdx?"on":undefined} style={{opacity:i>todayIdx?.45:1}}>{d}</span>)}
      </div>
    </div>
  </>);
}

/* ── 잔디 ── 세로 5칸(월~금) × N주 */
const GRASS_BG={full:"var(--blue)",part:"rgba(var(--blue-rgb),.32)",empty:"var(--fill)",pre:"var(--fill2)",future:"transparent"};
function Grass({cell,endISO,weeks,today,gap=3,radius=3}){
  const endMon=mondayOf(fromISO(endISO));
  const cols=Array.from({length:weeks},(_,i)=>addDays(endMon,-(weeks-1-i)*7));
  /* 월 라벨은 주말 포함 7일 안에 1일이 있는지로 판단 (1일이 주말이어도 표시) */
  const firstOf=cols.map(m=>Array.from({length:7},(_,i)=>toISO(addDays(m,i))).find(x=>x.endsWith("-01")));
  /* 그 주에 1일이 있으면 월 표시. 첫 칸은 바로 옆 칸에 월 표시가 없을 때만 (글자 겹침 방지) */
  const monthAt=cols.map((m,i)=>firstOf[i]?fromISO(firstOf[i]).getMonth()+1:i===0&&!firstOf[1]?m.getMonth()+1:null);
  const lab={fontSize:11,color:"var(--label2)",lineHeight:1,whiteSpace:"nowrap"};
  const kids=[<span key="dm"/>];
  DAYS.forEach((d,i)=>kids.push(<span key={"d"+i} style={{...lab,display:"flex",alignItems:"center",paddingRight:4,visibility:i%2===0?"visible":"hidden"}}>{d}</span>));
  cols.forEach((m,ci)=>{
    kids.push(<span key={"m"+ci} style={{...lab,width:0,overflow:"visible",alignSelf:"end"}}>{monthAt[ci]?`${monthAt[ci]}월`:""}</span>);
    weekDatesFrom(m).forEach(iso=>{
      const st=cell(iso);
      kids.push(<span key={iso} title={iso} style={{aspectRatio:"1",borderRadius:radius,background:GRASS_BG[st],
        boxShadow:iso===today?"0 0 0 1.5px var(--label)":"none"}}/>);
    });
  });
  return(
    <div style={{display:"grid",gridTemplateColumns:`auto repeat(${weeks},minmax(0,1fr))`,
      gridTemplateRows:`16px repeat(${DAYS.length},auto)`,gridAutoFlow:"column",columnGap:gap,rowGap:gap,minWidth:0}}>
      {kids}
    </div>
  );
}

/* 회고 목록의 한 행 — 이름 + 연속 기록 | 최근 3주 잔디 · 누르면 상세 */
function ItemRow({st,today,onOpen}){
  const mon0=addDays(mondayOf(fromISO(today)),-14);
  const weeks=[0,1,2].map(i=>weekDatesFrom(addDays(mon0,i*7)));
  return(
    <button className="btn cell tap" onClick={onOpen} aria-label={`${st.h.name} 자세히 보기`}>
      <div className="cell-body">
        <div className="cell-main">
          <div className="cell-title" style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st.h.name}</div>
          <div className="cell-sub">
            이번 주 {Math.min(st.wc,st.t)}/{st.t}
            {st.cur>0&&<span className="streak"><Icon name="flame" size={13}/>{st.cur}{st.unit} 연속</span>}
          </div>
        </div>
        <div aria-hidden="true" style={{display:"grid",gridTemplateColumns:`repeat(${DAYS.length},10px)`,gap:3,flex:"0 0 auto"}}>
          {weeks.flat().map(iso=>{const k=st.cell(iso);return <span key={iso} style={{width:10,height:10,borderRadius:2.5,
            background:GRASS_BG[k],boxShadow:iso===today?"0 0 0 1.5px var(--label)":"none"}}/>;})}
        </div>
        <span className="disclosure"><Chevron size={14}/></span>
      </div>
    </button>
  );
}

/* ── 루틴 상세 ── 잔디 · 통계 · 월별 기록 (iOS 푸시 화면처럼) */
const PAGE_WEEKS=22;
function ItemDetail({st,today,isNotion,onClose,backLabel="회고"}){
  const [page,setPage]=useState(0);
  const maxPage=Math.floor(52/PAGE_WEEKS);
  const endISO=toISO(addDays(mondayOf(fromISO(today)),-7*PAGE_WEEKS*page+WORKDAYS-1));
  const startISO=toISO(addDays(fromISO(endISO),-(7*PAGE_WEEKS-1)));
  const md=(iso)=>{const d=fromISO(iso);return `${d.getFullYear()!==fromISO(today).getFullYear()?`${d.getFullYear()}년 `:""}${d.getMonth()+1}월 ${d.getDate()}일`;};
  useEffect(()=>{const esc=(e)=>{if(e.key==="Escape")onClose();};document.addEventListener("keydown",esc);return()=>document.removeEventListener("keydown",esc);},[onClose]);

  const byMonth=[]; for(const iso of st.records){const k=iso.slice(0,7);let g=byMonth[byMonth.length-1];if(!g||g.k!==k){g={k,items:[]};byMonth.push(g);}g.items.push(iso);}
  const row=(label,value,sub)=>(
    <div className="cell"><div className="cell-body">
      <div className="cell-main"><div className="cell-title">{label}</div>{sub&&<div className="cell-sub">{sub}</div>}</div>
      <span className="cell-value num">{value}</span>
    </div></div>
  );
  return(
    <div role="dialog" aria-modal="true" aria-label={`${st.h.name} 기록`} className="sheet">
      <header className="navbar scrolled" style={{position:"sticky"}}>
        <div className="navbar-in">
          <button className="btn glass-ico" onClick={onClose} aria-label={`${backLabel}(으)로 돌아가기`}><Chevron dir="l" size={20}/></button>
          <span className="nav-title">{st.h.name}</span>
          {isNotion
            ? <a className="btn txt" style={{justifySelf:"end"}} href={`https://www.notion.so/${String(st.h.id).replace(/-/g,"")}`} target="_blank" rel="noopener noreferrer" aria-label="노션에서 편집">편집</a>
            : <span/>}
        </div>
      </header>
      <div className="wrap" style={{paddingTop:8}}>
        <div className="card">
          <div className="card-head" style={{color:"var(--blue)"}}><Icon name="check" size={17}/>{freqLabel(st.h)}</div>
          <div style={{marginTop:12}}><Grass cell={st.cell} endISO={endISO} weeks={PAGE_WEEKS} today={today}/></div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12}}>
            <button className="btn nav-ico" onClick={()=>setPage(p=>Math.min(maxPage,p+1))} disabled={page>=maxPage} aria-label="이전 기간"><Chevron dir="l"/></button>
            <span style={{fontSize:13,color:"var(--label2)"}}>{md(startISO)} – {md(endISO>today?today:endISO)}</span>
            <button className="btn nav-ico" onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} aria-label="다음 기간"><Chevron dir="r"/></button>
          </div>
        </div>

        <section className="group" style={{marginTop:20}}>
          <div className="cells">
            {row("연속 기록",`${st.cur}${st.unit}`,`가장 길었던 건 ${st.best}${st.unit}`)}
            {row("전체 체크",`${st.total}회`,`${md(st.startISO)}부터`)}
            {row("이번 주",`${Math.min(st.wc,st.t)}/${st.t}`,st.wc>=st.t?"목표를 채웠어요":`${st.t-st.wc}회 남았어요`)}
            {row("목표를 채운 주",st.elig?`${st.ok}주`:"–",st.elig?`최근 ${st.elig}주 가운데`:"아직 지난 기록이 없어요")}
          </div>
        </section>

        {byMonth.length===0
          ? <p className="group-foot" style={{marginTop:24}}>아직 체크한 날이 없어요.</p>
          : byMonth.slice(0,6).map(g=>{
              const [y,m]=g.k.split("-");
              return(
                <section key={g.k} className="group">
                  <div className="group-head small"><h2>{y}년 {Number(m)}월</h2><span className="group-side num">{g.items.length}회</span></div>
                  <div className="cells">
                    {g.items.map(iso=>{const d=fromISO(iso);return(
                      <div key={iso} className="cell"><div className="cell-body">
                        <span className="cell-title">{d.getMonth()+1}월 {d.getDate()}일</span>
                        <span className="cell-value">{wdOf(iso)}요일</span>
                      </div></div>);})}
                  </div>
                </section>
              );
            })}
      </div>
    </div>
  );
}

/* ── 오늘 할 일 ── 둥근 체크 = 노션 '완료', 이름을 누르면 바로 고침, 맨 아래에서 새로 추가 (미리 알림 앱처럼) */
/* 노션 선택지 색 이름 → 태그 색 (노션 팔레트와 같은 이름만 받음) */
const NOTION_COLORS=["default","gray","brown","orange","yellow","green","blue","purple","pink","red"];
function TasksSection({title,tasks,err,dbUrl,onAdd,onToggle,onRename}){
  const [draft,setDraft]=useState("");
  const [edit,setEdit]=useState(null);   // { id, text }
  const add=()=>{const t=draft.trim();if(!t)return;onAdd(t);setDraft("");};
  const commit=()=>{
    if(!edit) return;
    const t=tasks.find(x=>x.id===edit.id), v=edit.text.trim();
    if(t&&v&&v!==t.title) onRename(t,v);
    setEdit(null);
  };
  const done=tasks.filter(t=>t.done).length;
  return(
    <section className="group">
      <div className="group-head">
        <h2>{title}</h2>
        <span className="group-side">
          {tasks.length>0&&<span className="num">{done}/{tasks.length}</span>}
          {/* 우선순위·마감일 바꾸기, 삭제는 노션 과업 목록에서 */}
          {dbUrl&&<a className="btn txt" href={dbUrl} target="_blank" rel="noopener noreferrer">관리하기</a>}
        </span>
      </div>
      {err&&<div className="banner" style={{margin:"0 0 8px"}}>{err}</div>}
      <div className="cells">
        {tasks.map(t=>(
          <div key={t.id} className="cell">
            <span role="checkbox" aria-checked={t.done} aria-label={t.title} tabIndex={0} className="hit"
              onClick={()=>onToggle(t)}
              onKeyDown={e=>{if(e.key===" "||e.key==="Enter"){e.preventDefault();onToggle(t);}}}><CheckBox on={t.done}/></span>
            <div className="cell-body">
              {edit?.id===t.id
                ? <input className="cell-input" autoFocus value={edit.text} maxLength={200} aria-label="할 일 이름"
                    onChange={e=>setEdit({id:t.id,text:e.target.value})} onBlur={commit}
                    onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();commit();}if(e.key==="Escape")setEdit(null);}}/>
                : <button className={"btn cell-title edit"+(t.done?" done":"")} onClick={()=>setEdit({id:t.id,text:t.title})}>{t.title}</button>}
              {t.priority&&edit?.id!==t.id&&
                <span className={"tag c-"+(NOTION_COLORS.includes(t.priorityColor)?t.priorityColor:"default")} aria-label={`우선순위 ${t.priority}`}>{t.priority}</span>}
            </div>
          </div>
        ))}
        <div className="cell">
          <span className="add-ico" aria-hidden="true"/>
          <div className="cell-body">
            <input className="cell-input" value={draft} maxLength={200} placeholder="할 일 추가"
              aria-label="새 할 일" onChange={e=>setDraft(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();add();}}}/>
            {draft.trim()&&<button className="btn txt strong" onClick={add}>추가</button>}
          </div>
        </div>
      </div>
      {tasks.length===0&&!err&&<p className="group-foot">이날 마감인 할 일이 없어요. 노션 과업 목록과 함께 맞춰져요.</p>}
    </section>
  );
}

/* ── 하루 평가 ── 접힌 상태: 한 줄 / 펼친 상태: 별 5개 + 레슨런 + 제출하기 */
function RatingCard({score,open,lessonCount,onToggle,onSubmit}){
  const [pick,setPick]=useState(score);
  const [text,setText]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{setPick(score);},[score,open]);
  const dirty=pick!==score||!!text.trim();
  const submit=async()=>{
    if(!dirty||busy) return;
    setBusy(true);
    try{ await onSubmit(pick,text.trim()); setText(""); }catch(e){}
    finally{ setBusy(false); }
  };
  return(
    <section className="group" style={{marginTop:0}}>
      <div className="cells">
        <button className="btn cell tap" onClick={onToggle} aria-expanded={open}>
          <span className="lead-ico" style={{background:"var(--orange)"}}><Icon name="star" size={16}/></span>
          <div className="cell-body">
            <span className="cell-title">하루 평가하기</span>
            <span style={{display:"flex",alignItems:"center",gap:8}}>
              {!open&&score>0&&<Stars n={score} size={13}/>}
              {!open&&lessonCount>0&&<span className="cell-value" style={{fontSize:15}}>레슨런 {lessonCount}</span>}
              <span className="disclosure" style={{transform:open?"rotate(90deg)":"none"}}><Chevron size={14}/></span>
            </span>
          </div>
        </button>
        {open&&<>
          <div className="cell" style={{cursor:"default"}}>
            <div className="cell-body" style={{justifyContent:"center",padding:"10px 16px 12px 0"}}>
              <div role="radiogroup" aria-label="하루 평점" style={{display:"flex",gap:6}}>
                {[1,2,3,4,5].map(n=>(
                  <button key={n} role="radio" aria-checked={pick===n} aria-label={`${n}점`} className={"btn star"+(n<=pick?" on":"")}
                    onClick={()=>setPick(p=>p===n?0:n)}><StarSvg size={36}/></button>
                ))}
              </div>
            </div>
          </div>
          <div className="cell" style={{cursor:"text"}}>
            <div className="cell-body" style={{padding:"12px 16px 12px 0"}}>
              <textarea className="ta" rows={3} maxLength={500} value={text} onChange={e=>setText(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();submit();}}}
                placeholder="오늘 배운 점이나 다음에 바꿔 볼 점을 적어 보세요" aria-label="레슨런"/>
            </div>
          </div>
          <div className="cell" style={{cursor:"default"}}>
            <div className="cell-body" style={{padding:"10px 16px 12px 0"}}>
              <button className="btn filled" style={{width:"100%"}} disabled={!dirty||busy} onClick={submit}>{busy?"제출 중":"제출하기"}</button>
            </div>
          </div>
        </>}
      </div>
    </section>
  );
}
const STAR="M12 2.8l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.6l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z";
function StarSvg({size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={STAR} strokeWidth="1.4" strokeLinejoin="round"/></svg>;
}
function Stars({n,size=13}){
  return <span className="stars" role="img" aria-label={`${n}점`}>
    {[1,2,3,4,5].map(i=><span key={i} className={i<=n?"on":undefined}><StarSvg size={size}/></span>)}</span>;
}

/* ── 하루 평점 추이 ── 최근 4주 평일 막대 (높이 = 점수) + 이번 주 평균 */
function RatingTrend({ratings,today}){
  const curMon=mondayOf(fromISO(today));
  const weeks=[3,2,1,0].map(i=>weekDatesFrom(addDays(curMon,-7*i)));
  const avg=(ds)=>{const v=ds.map(d=>ratings[d]).filter(Boolean);return v.length?(v.reduce((a,b)=>a+b,0)/v.length):null;};
  const cur=avg(weeks[3]);
  const f=(v)=>v==null?"–":v.toFixed(1);
  const W=560,H=72,G=18,BW=(W-G*3)/20-6;
  return(
    <div className="card">
      <div className="card-head" style={{color:"var(--orange)"}}><Icon name="star" size={16}/>이번 주 평점</div>
      <div className="value"><span className="num">{f(cur)}</span>{cur!=null&&<small>점</small>}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{display:"block",marginTop:14}} aria-hidden="true">
        {weeks.map((ds,wi)=>ds.map((d,di)=>{
          const x=wi*((W-G*3)/4+G)+di*((W-G*3)/20)+3, v=ratings[d]||0, h=v?Math.max(5,(H-2)*v/5):4;
          return <rect key={d} x={x} y={H-h} width={BW} height={h} rx="3"
            fill={d>today?"transparent":v?"var(--orange)":"var(--fill)"}><title>{`${d} ${v?v+"점":"기록 없음"}`}</title></rect>;
        }))}
      </svg>
      <div className="axis" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",columnGap:G/W*100+"%"}}>
        {weeks.map((ds,i)=><span key={i} className={i===3?"on":undefined}>{i===3?"이번 주":`${fromISO(ds[0]).getMonth()+1}/${fromISO(ds[0]).getDate()}`}</span>)}
      </div>
    </div>
  );
}

/* ── 레슨런 목록 ── 주차별로 모아 보고, ⋯ 메뉴에서 수정·삭제 (쓰기는 오늘 탭의 하루 평가하기에서) */
function LessonsList({lessons,today,onEdit,onDelete}){
  const [menu,setMenu]=useState(null);   // 열린 ⋯ 메뉴의 레슨런 id
  const [edit,setEdit]=useState(null);   // { id, text }
  useEffect(()=>{
    if(!menu) return;
    const close=()=>setMenu(null);
    const esc=(e)=>{if(e.key==="Escape")close();};
    document.addEventListener("click",close); document.addEventListener("keydown",esc);
    return()=>{document.removeEventListener("click",close);document.removeEventListener("keydown",esc);};
  },[menu]);
  const save=()=>{const v=edit.text.trim();if(v)onEdit(edit.id,v);setEdit(null);};
  const groups=[];
  for(const l of [...lessons].sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)){
    const k=toISO(mondayOf(fromISO(l.date)));
    let g=groups[groups.length-1]; if(!g||g.k!==k){g={k,items:[]};groups.push(g);} g.items.push(l);
  }
  const curK=toISO(mondayOf(fromISO(today)));
  if(!groups.length) return <p className="group-foot" style={{marginTop:20}}>아직 레슨런이 없어요. 오늘 탭의 하루 평가하기에서 남길 수 있어요.</p>;
  return groups.map(g=>{const wk=weekOfMonth(g.k);return(
    <section key={g.k} className="group">
      <div className="group-head small"><h2>{g.k===curK?"이번 주":`${wk.m}월 ${wk.w}주차`}</h2><span className="group-side num">{g.items.length}개</span></div>
      <div className="cells">
        {g.items.map(l=>{const d=fromISO(l.date);return(
          <div key={l.id} className="cell" style={{cursor:"default",alignItems:"flex-start"}}>
            <div className="cell-body" style={{alignItems:"flex-start"}}>
              {edit?.id===l.id
                ? <div className="cell-main">
                    <textarea className="ta" rows={3} autoFocus maxLength={500} value={edit.text} aria-label="레슨런 수정"
                      onChange={e=>setEdit({id:l.id,text:e.target.value})}
                      onKeyDown={e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();save();}if(e.key==="Escape")setEdit(null);}}/>
                    <div style={{display:"flex",justifyContent:"flex-end",gap:4,marginTop:4}}>
                      <button className="btn txt" onClick={()=>setEdit(null)}>취소</button>
                      <button className="btn txt strong" disabled={!edit.text.trim()} onClick={save}>저장</button>
                    </div>
                  </div>
                : <div className="cell-main">
                    <div className="cell-title" style={{whiteSpace:"pre-wrap",lineHeight:1.45}}>{l.text}</div>
                    {(()=>{const tg=l.tags?.length?l.tags:extractTags(l.text);   // 태그 기능 전에 저장된 레슨런은 화면에서만 뽑아 보여줌
                      return tg.length>0&&<div className="chips">{tg.map(t=><span key={t} className="chip">{t}</span>)}</div>;})()}
                    <div className="cell-sub">{d.getMonth()+1}월 {d.getDate()}일 {wdOf(l.date)}요일</div>
                  </div>}
              {edit?.id!==l.id&&
                <div style={{position:"relative",flex:"0 0 auto"}}>
                  <button className="btn more" aria-label="더보기" aria-haspopup="menu" aria-expanded={menu===l.id}
                    onClick={e=>{e.stopPropagation();setMenu(m=>m===l.id?null:l.id);}}>
                    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="7.6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="16.4" cy="12" r="1.3" fill="currentColor"/></svg>
                  </button>
                  {menu===l.id&&
                    <div role="menu" className="menu" onClick={e=>e.stopPropagation()}>
                      <button role="menuitem" className="btn plain" onClick={()=>{setMenu(null);setEdit({id:l.id,text:l.text});}}>수정</button>
                      <button role="menuitem" className="btn" onClick={()=>{setMenu(null);onDelete(l.id);}}>삭제</button>
                    </div>}
                </div>}
            </div>
          </div>);})}
      </div>
    </section>);});
}

const CSS=`
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');
  /* Apple 시스템 앱 — iOS 시스템 색·SF 글꼴(Apple 기기), 그 외 기기는 Pretendard */
  :root{
    --bg:#F2F2F7;--cell:#FFFFFF;--label:#000000;--label2:rgba(60,60,67,.6);--label3:rgba(60,60,67,.3);
    --sep:rgba(60,60,67,.29);--fill:rgba(120,120,128,.16);--fill2:rgba(120,120,128,.08);--gray2:#AEAEB2;--gray3:#C7C7CC;
    --gray4:#D1D1D6;--blue:#007AFF;--blue-rgb:0,122,255;--green:#34C759;--orange:#FF9500;--red:#FF3B30;--purple:#AF52DE;
    --bar:rgba(249,249,249,.86);--bar-top:rgba(242,242,247,.9);--bg-0:rgba(242,242,247,0);
    --glass:rgba(255,255,255,.72);--glass-edge:rgba(0,0,0,.06);--purple-rgb:175,82,222;--banner:#FFF4E0;--banner-ink:#9A5B00;
    color-scheme:light;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#000000;--cell:#1C1C1E;--label:#FFFFFF;--label2:rgba(235,235,245,.6);--label3:rgba(235,235,245,.3);
    --sep:rgba(84,84,88,.65);--fill:rgba(120,120,128,.32);--fill2:rgba(120,120,128,.16);--gray2:#636366;--gray3:#48484A;
    --gray4:#3A3A3C;--blue:#0A84FF;--blue-rgb:10,132,255;--green:#30D158;--orange:#FF9F0A;--red:#FF453A;--purple:#BF5AF2;
    --bar:rgba(22,22,24,.82);--bar-top:rgba(0,0,0,.86);--bg-0:rgba(0,0,0,0);
    --glass:rgba(44,44,46,.7);--glass-edge:rgba(255,255,255,.08);--purple-rgb:191,90,242;--banner:#2E2310;--banner-ink:#FFC56B;
    color-scheme:dark;
  }}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);max-width:100%;overflow-x:clip}
  html{scrollbar-gutter:stable both-edges}   /* 탭마다 길이가 달라 스크롤바가 생겼다 없어지며 화면이 밀리던 것 방지 */
  .app{min-height:100vh;color:var(--label);font-size:17px;line-height:1.3;letter-spacing:-0.01em;-webkit-font-smoothing:antialiased;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Apple SD Gothic Neo","Pretendard",system-ui,sans-serif}
  .num{font-variant-numeric:tabular-nums}
  button,input,textarea{font-family:inherit;color:inherit;letter-spacing:inherit}
  .wrap{max-width:600px;margin:0 auto;padding:0 max(16px,env(safe-area-inset-left)) calc(112px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-right))}

  /* 위쪽 막대 — 처음엔 투명, 스크롤하면 반투명 + 작은 제목 + 가는 선 */
  /* 위쪽 막대 — 선 없이 바탕색에서 아래로 흐려짐 (상태 바도 같은 바탕색) */
  .navbar{position:sticky;top:0;z-index:20;padding-top:env(safe-area-inset-top);
    background:linear-gradient(var(--bg) 0,var(--bg) 62%,var(--bg-0) 100%)}
  .navbar-in{max-width:600px;margin:0 auto;height:44px;padding:0 8px 0 16px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center}

  .nav-title{font-size:17px;font-weight:600;opacity:0;transition:opacity .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:56vw}
  .navbar.scrolled .nav-title{opacity:1}
  .nav-actions{display:flex;align-items:center;gap:2px}
  .large-title{font-size:34px;font-weight:700;letter-spacing:.01em;line-height:1.2;margin:2px 0 0}
  .subtitle{font-size:15px;color:var(--label2);margin:2px 0 0}

  .btn{cursor:pointer;-webkit-tap-highlight-color:transparent;border:none;background:none;padding:0}
  .btn:disabled{opacity:.3;cursor:default}
  .btn.txt{color:var(--blue);font-size:17px;padding:6px 8px;text-decoration:none}
  .btn.txt.strong{font-weight:600}
  .group-side .btn.txt{font-size:15px;padding:0 0 0 12px}
  .btn.nav-ico{color:var(--label);width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:20px}
  .navbar .btn.nav-ico,.btn.glass-ico{background:var(--glass);box-shadow:0 1px 6px rgba(0,0,0,.07),inset 0 0 0 .5px var(--glass-edge);
    -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
  .nav-actions{gap:8px!important}
  .btn.glass-ico{color:var(--label);width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:20px;justify-self:start}
  .btn.filled{background:var(--blue);color:#fff;font-size:17px;font-weight:600;border-radius:999px;padding:15px 18px}
  .btn:focus-visible,.hit:focus-visible,.cell.tap:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:8px}

  .banner{background:var(--banner);color:var(--banner-ink);border-radius:20px;padding:12px 16px;font-size:15px;line-height:1.4;margin-top:14px}

  /* 인셋 그룹 목록 */
  .group{margin-top:26px}
  .group-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:0 4px 8px 4px}
  .group-head h2{font-size:22px;font-weight:700;margin:0;letter-spacing:.01em}
  .group-head.small{padding:0 16px 6px}
  .group-head.small h2{font-size:15px;font-weight:400;color:var(--label2)}
  .group-side{display:flex;align-items:baseline;font-size:15px;color:var(--label2)}
  .group-foot{font-size:13px;color:var(--label2);margin:8px 16px 0;line-height:1.4}
  .cells{background:var(--cell);border-radius:26px;overflow:hidden}
  .cell{display:flex;align-items:center;gap:14px;width:100%;padding-left:18px;text-align:left;color:inherit;font-size:17px;min-height:52px;position:relative}
  .cell.tap{cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none}
  .cell.tap:active{background:var(--fill2)}
  .cell-body{flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px 14px 0;
    box-shadow:inset 0 -.5px 0 var(--sep)}
  .cell:last-child>.cell-body{box-shadow:none}
  .cell-main{flex:1;min-width:0}
  .cell-title{font-size:17px;word-break:keep-all;line-height:1.3}
  .cell-title.done{color:var(--label2)}
  .cell-sub{font-size:15px;color:var(--label2);margin-top:2px;display:flex;align-items:center;gap:8px}
  .cell-value{font-size:17px;color:var(--label2);flex:0 0 auto}
  .cell-value.met{color:var(--blue)}
  .cell-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font-size:17px;padding:0}
  .cell-input::placeholder,.ta::placeholder{color:var(--label3)}
  .btn.cell-title.edit{flex:1;text-align:left;cursor:text}
  /* 우선순위 태그 — 노션 선택지 색 팔레트 */
  .tag{flex:0 0 auto;font-size:13px;line-height:1;padding:4px 7px;border-radius:5px;color:var(--t-ink);background:var(--t-bg);white-space:nowrap}
  .c-default{--t-bg:rgba(84,72,49,.08);--t-ink:#32302C}.c-gray{--t-bg:#F1F1EF;--t-ink:#787774}.c-brown{--t-bg:#F4EEEE;--t-ink:#976D57}
  .c-orange{--t-bg:#FBECDD;--t-ink:#CC782F}.c-yellow{--t-bg:#FBF3DB;--t-ink:#C29343}.c-green{--t-bg:#EDF3EC;--t-ink:#548164}
  .c-blue{--t-bg:#E7F3F8;--t-ink:#337EA9}.c-purple{--t-bg:#F7F3F8;--t-ink:#9065B0}.c-pink{--t-bg:#FBF2F5;--t-ink:#C14C8A}.c-red{--t-bg:#FDEBEC;--t-ink:#C4554D}
  @media(prefers-color-scheme:dark){
    .tag{--t-ink:rgba(255,255,255,.86)}
    .c-default{--t-bg:#373737}.c-gray{--t-bg:#2F2F2F}.c-brown{--t-bg:#4A3228}.c-orange{--t-bg:#5C3B23}.c-yellow{--t-bg:#564328}
    .c-green{--t-bg:#243D30}.c-blue{--t-bg:#143A4E}.c-purple{--t-bg:#3C2D49}.c-pink{--t-bg:#4E2C3C}.c-red{--t-bg:#522E2A}}
  .disclosure{color:var(--gray3);display:flex;transition:transform .2s}
  .streak{display:inline-flex;align-items:center;gap:2px;color:var(--orange)}
  .lead-ico{width:30px;height:30px;border-radius:9px;color:#fff;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  .add-ico{width:24px;height:24px;border-radius:50%;background:var(--blue);flex:0 0 auto;position:relative}
  .add-ico::before,.add-ico::after{content:"";position:absolute;left:50%;top:50%;background:#fff;border-radius:1px;transform:translate(-50%,-50%)}
  .add-ico::before{width:12px;height:2px}.add-ico::after{width:2px;height:12px}

  /* 미리 알림 같은 둥근 체크 */
  .hit{display:flex;padding:8px;margin:-8px;cursor:pointer;border-radius:8px}
  .cbox{width:24px;height:24px;border-radius:8px;border:1.5px solid var(--gray3);flex:0 0 auto;display:flex;align-items:center;justify-content:center;
    transition:background .15s,border-color .15s}
  .cbox.on{background:var(--blue);border-color:var(--blue)}
  .cbox.on svg{animation:pop .22s cubic-bezier(.3,1.5,.6,1)}
  @keyframes pop{from{transform:scale(.3)}}

  /* 요약 카드 (건강 앱처럼) */
  .card{background:var(--cell);border-radius:26px;padding:18px 20px 18px;margin-top:12px}
  .card-head{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:600}
  .value{display:flex;align-items:baseline;gap:4px;margin-top:10px}
  .value .num{font-family:ui-rounded,"SF Pro Rounded",-apple-system,"Pretendard",sans-serif;font-size:34px;font-weight:700;line-height:1}
  .value small{font-size:15px;font-weight:600;color:var(--label2)}
  /* 회고 요약 카드 — 건강 앱 요약처럼 넉넉한 둥근 카드 */
  .summary{margin-top:18px;display:flex;flex-direction:column;gap:12px}
  .btn.sum-card{display:block;width:100%;text-align:left;background:var(--cell);border-radius:28px;padding:18px 20px 20px;color:inherit;font-size:17px}
  .btn.sum-card:active{transform:scale(.985);transition:transform .1s}
  .sum-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .sum-title{display:flex;align-items:center;gap:6px;font-size:17px;font-weight:600}
  .sum-meta{display:flex;align-items:center;gap:6px;font-size:15px;color:var(--label2)}
  .sum-meta svg{color:var(--gray3)}
  .sum-body{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-top:22px;min-height:56px}
  .sum-value{display:flex;align-items:baseline;gap:4px}
  .sum-value .num{font-family:ui-rounded,"SF Pro Rounded",-apple-system,"Pretendard",sans-serif;font-size:36px;font-weight:700;line-height:1;letter-spacing:-.01em}
  .sum-value small{font-size:17px;font-weight:500;color:var(--label2)}
  .sum-empty{font-size:28px;font-weight:700;line-height:1.1}
  .sum-quote{font-size:19px;font-weight:600;line-height:1.35;margin:0;word-break:keep-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .sum-foot{font-size:15px;color:var(--label2);margin-top:6px}
  .sum-bars{flex:0 0 auto}
  .axis{display:flex;justify-content:space-between;font-size:12px;color:var(--label2)}
  .axis>span{width:0;display:flex;justify-content:center;white-space:nowrap}
  .axis[style*="grid"]>span{width:auto}
  .axis .on{color:var(--label);font-weight:600}
  .mini-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
  .mini-list li{display:flex;gap:12px;font-size:16px;line-height:1.4;word-break:keep-all;white-space:pre-wrap}
  .mini-list li span{color:var(--label2);font-size:15px;flex:0 0 auto}
  .tip{position:absolute;top:0;z-index:2;pointer-events:none;white-space:nowrap;background:var(--cell);border-radius:10px;padding:8px 12px;
    font-size:13px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,.16)}

  .btn.star{line-height:0;padding:2px}
  .btn.star path,.stars path{fill:var(--fill);stroke:none}
  .btn.star.on path,.stars .on path{fill:var(--orange)}
  .btn.star:active svg{transform:scale(.88)}
  .stars{display:inline-flex;gap:1px;line-height:0}

  .ta{width:100%;resize:none;border:none;outline:none;background:transparent;font-size:17px;line-height:1.4;padding:0}
  .btn.more{color:var(--label3);width:32px;height:32px;display:flex;align-items:center;justify-content:center;margin:-6px -4px 0 0}
  .menu{position:absolute;right:0;top:32px;z-index:5;min-width:150px;background:var(--bar);-webkit-backdrop-filter:blur(30px);backdrop-filter:blur(30px);
    border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.18);overflow:hidden}
  .menu .btn{display:block;width:100%;text-align:left;color:var(--red);font-size:17px;padding:11px 16px}
  .menu .btn.plain{color:var(--label);box-shadow:inset 0 -.5px 0 var(--sep)}
  .btn.filled:disabled{opacity:.35}

  /* 아래 탭 막대 */
  /* 아래 탭 막대 — 홈 인디케이터 위에 떠 있는 유리 캡슐, 선택한 탭은 안쪽 알약으로 */
  .tabbar{position:fixed;left:50%;transform:translateX(-50%);bottom:max(14px,env(safe-area-inset-bottom));z-index:30;display:flex;gap:4px;padding:5px;
    width:min(260px,calc(100% - 48px));border-radius:999px;background:var(--glass);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
    box-shadow:0 8px 30px rgba(0,0,0,.12),inset 0 0 0 .5px var(--glass-edge)}
  .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;color:var(--label);font-size:11px;font-weight:600;letter-spacing:0;padding:7px 0 6px;border-radius:999px;transition:background .2s,color .2s}
  .tab.on{color:var(--blue);background:var(--fill2)}

  .sheet{position:fixed;inset:0;z-index:90;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;background:var(--bg)}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .chip{font-size:13px;line-height:1;padding:5px 10px;border-radius:999px;background:rgba(var(--purple-rgb),.12);color:var(--purple)}
  .toast{position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:100;max-width:min(92vw,420px);
    background:rgba(30,30,32,.92);color:#fff;border-radius:999px;padding:12px 16px;font-size:15px;line-height:1.4;-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}
  .sk{border-radius:6px;background:var(--fill);animation:sk 1.4s ease-in-out infinite}
  @keyframes sk{0%,100%{opacity:1}50%{opacity:.5}}
  .fade{animation:fade .2s ease}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .sheet.push{animation:push .28s cubic-bezier(.2,.8,.2,1)}
  @keyframes push{from{transform:translateX(24%);opacity:.6}}
  @media(prefers-reduced-motion:reduce){.sheet.push{animation:none}.fade,.sk,.cbox.on svg{animation:none}.navbar,.nav-title,.disclosure{transition:none}}
`;
