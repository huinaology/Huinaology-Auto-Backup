const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');
const Config = require('../lib/config');

let frontendLogs = [];
// addLog   : 위젯 화면(Sync History & Logs)에도 노출되는 "사용자용" 요약 로그.
//            무엇이 연결됐는지/실패했는지만 담아서, 문제가 생기면 이 내용만 복사해
//            AI에게 붙여넣어도 원인 파악이 가능한 수준으로 유지한다.
// debugLog : Vercel 함수 로그(서버 콘솔)에만 남는 상세 디버그 로그.
//            체크포인트/Chain 내부 판정 등 개발자 트러블슈팅용 정보는 여기로만 보낸다.
function addLog(msg) { console.log(msg); frontendLogs.push(msg); }
function debugLog(msg) { console.log(msg); }

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =====================================================================
// [Checkpoint] 이어달리기(누락방지 쿠션)
//  목적 : 자동실행이 Vercel 60초 제한에 걸려 끊겨도, 다음(재시도) 크론이
//         "이어서" 처리하도록 진행상황을 Notion 상태 DB에 저장한다.
//  범위 : 여기서 다루는 것은 "어느 마스터 DB까지 끝냈는가" 뿐.
//         calculateTaskRange / linkCore / Chain / findOverlappingIds 등
//         동기화 계산 로직은 전혀 건드리지 않는다.
//  안전 : SYNC_STATE_DB_ID 환경변수가 없거나 상태 DB 접근에 실패하면
//         조용히 비활성화하고 기존과 100% 동일하게 "전체 실행"한다.
//  상태 DB 준비물 : 제목(title) 속성 1개 + '텍스트'(rich_text) 속성 1개.
// =====================================================================
const STATE_DB_ID = process.env.SYNC_STATE_DB_ID || '';
const RUN_BUDGET_MS = Number(process.env.SYNC_BUDGET_MS) || 40000;

function makeCycleId(params) {
    const slot = (params.slot || '').toString().toLowerCase().trim();
    if (!slot) return null; // 수동/기간/recent 실행은 체크포인트 미사용 (기존 동작 유지)
    const group = slot.replace(/_?retry/g, '') || 'auto'; // morning_retry -> morning
    const today = DateTime.now().setZone('Asia/Seoul').toISODate();
    return `${today}-${group}`;
}

async function initCheckpoint(notion, cycleId) {
    const disabled = { enabled: false, cycleId, status: 'new', completed: [], phase: 'scan', failedOnce: {} };
    if (!STATE_DB_ID || !cycleId) return disabled;
    try {
        const db = await notion.databases.retrieve({ database_id: STATE_DB_ID });
        const titleKey = Object.keys(db.properties).find(k => db.properties[k].type === 'title');
        const stateKey = Object.keys(db.properties).find(k => db.properties[k].type === 'rich_text');
        if (!titleKey || !stateKey) {
            addLog(`⚠️ 누락방지 저장 DB에 텍스트 속성이 없어 이 기능이 꺼진 채 실행됩니다. (제목+텍스트 속성 필요)`);
            return disabled;
        }
        const q = await notion.databases.query({
            database_id: STATE_DB_ID,
            filter: { property: titleKey, title: { equals: cycleId } },
            page_size: 1
        });
        let pageId = null, status = 'new', completed = [], phase = 'scan', failedOnce = {};
        if (q.results.length > 0) {
            pageId = q.results[0].id;
            const raw = q.results[0].properties[stateKey]?.rich_text?.[0]?.plain_text || '{}';
            let parsed = {};
            try { parsed = JSON.parse(raw); } catch (e) { parsed = {}; }
            status = parsed.status || 'running';
            completed = Array.isArray(parsed.completed) ? parsed.completed : [];
            phase = parsed.phase || 'scan';
            failedOnce = (parsed.failedOnce && typeof parsed.failedOnce === 'object') ? parsed.failedOnce : {};
        }
        return { enabled: true, titleKey, stateKey, pageId, cycleId, status, completed, phase, failedOnce };
    } catch (e) {
        addLog(`⚠️ 누락방지 저장 DB 연결 실패로 이 기능이 꺼진 채 실행됩니다: ${e.message}`);
        return disabled;
    }
}

async function saveCheckpoint(notion, cp, patch = {}) {
    if (!cp.enabled) return;
    try {
        if (patch.completed) cp.completed = patch.completed;
        if (patch.status) cp.status = patch.status;
        if (patch.phase) cp.phase = patch.phase;
        const body = JSON.stringify({
            status: cp.status || 'running',
            phase: cp.phase || 'scan',
            completed: cp.completed || [],
            failedOnce: cp.failedOnce || {},
            updatedAt: DateTime.now().setZone('Asia/Seoul').toISO()
        });
        const props = {
            [cp.titleKey]: { title: [{ text: { content: cp.cycleId } }] },
            [cp.stateKey]: { rich_text: [{ text: { content: body } }] }
        };
        if (cp.pageId) {
            await notion.pages.update({ page_id: cp.pageId, properties: props });
        } else {
            const created = await notion.pages.create({
                parent: { database_id: STATE_DB_ID },
                properties: props
            });
            cp.pageId = created.id;
        }
    } catch (e) {
        debugLog(`[Checkpoint] 저장 실패 (계속 진행): ${e.message}`);
    }
}

function getPageTitle(item) {
    const titleProp = Object.values(item.properties).find(p => p.type === 'title');
    return titleProp?.title[0]?.plain_text || "제목없음";
}

// 로그 표시용 아이콘 매핑 (감지 사유 → 아이콘). 판정 로직/함수명과 무관.
function reasonIcon(reason) {
    const r = (reason || '').toLowerCase();
    if (r.includes('today')) return '⚡';
    if (r.includes('ipr')) return '📅';
    if (r.includes('chain')) return '🔗';
    if (r.includes('ongoing')) return '🔄';
    if (r.includes('finance')) return '💰';
    return '';
}

function getSafeDateRange(prop) {
    if (!prop) return null;
    if (prop.type === 'date' && prop.date) {
        return { start: prop.date.start.substring(0, 10), end: (prop.date.end || prop.date.start).substring(0, 10) };
    }
    if (prop.type === 'formula' && prop.formula && prop.formula.type === 'date' && prop.formula.date) {
        return { start: prop.formula.date.start.substring(0, 10), end: (prop.formula.date.end || prop.formula.date.start).substring(0, 10) };
    }
    return null;
}

// Progress relation 에 값이 하나라도 있으면 true (진행 상태가 있는 일정)
function hasProgress(props) {
    const k = Object.keys(props).find(k => k.toLowerCase() === 'progress');
    const p = k ? props[k] : null;
    return !!(p && ((p.relation && p.relation.length > 0) || p.has_more));
}

// =====================================================================
// calculateTaskRange - Today > ipr Calendar > Final Update > Schedule
// =====================================================================
function calculateTaskRange(item, dbName) {
    const props = item.properties;
    const now = DateTime.now().setZone('Asia/Seoul');
    const todayISO = now.toISODate();

    const schedPropKey = Object.keys(props).find(k => k.toLowerCase() === 'schedule') || Config.SCHEMA.SCHEDULE.name;
    const schedRange = getSafeDateRange(props[schedPropKey]);
    if (!schedRange) return null;

    const startStr = schedRange.start;
    const endStr = schedRange.end;

    // Finance DB는 항상 1일치로 고정
    if (dbName === "Finance") return { start: startStr, end: startStr, isActiveToday: false, detectReason: "Finance DB" };

    let finalEndStr = endStr;
    let isActiveToday = false;
    let detectReason = "";

    // [1순위] Today 속성
    const todayPropKey = Object.keys(props).find(k => k.includes('Today') || k.includes('today'));
    if (todayPropKey && props[todayPropKey]) {
        const tv = props[todayPropKey];
        if (tv.type === 'formula' && tv.formula) {
            const fv = tv.formula;
            if (fv.type === 'string' && typeof fv.string === 'string') {
                const s = fv.string.trim().toLowerCase();
                if ((s.includes('today') || s.includes('오늘')) && !s.includes('yesterday') && !s.includes('tomorrow')) {
                    isActiveToday = true;
                    detectReason = 'Today Formula';
                }
            } else if (fv.type === 'date' && fv.date) {
                const fEnd = (fv.date.end || fv.date.start || '').substring(0, 10);
                if (fEnd === todayISO) { isActiveToday = true; detectReason = 'Today Date'; }
            } else if (fv.type === 'boolean' && fv.boolean === true) {
                isActiveToday = true;
                detectReason = 'Today Bool';
            }
        }
    }

    // [2순위] ipr Calendar 속성
    if (!isActiveToday) {
        const iprCalKey = Object.keys(props).find(k => k.toLowerCase().includes('ipr calendar'));
        if (iprCalKey && props[iprCalKey]) {
            const iv = props[iprCalKey];
            if (iv.type === 'formula' && iv.formula) {
                const fv = iv.formula;
                if (fv.type === 'date' && fv.date) {
                    const fStart = fv.date.start ? fv.date.start.substring(0, 10) : null;
                    const fEnd = (fv.date.end || fv.date.start || '').substring(0, 10);
                    if (fEnd === todayISO || (fStart && fStart <= todayISO && fEnd >= todayISO)) {
                        isActiveToday = true;
                        detectReason = 'ipr Date';
                    }
                }
            }
        }
    }

    // [3순위] Final Update
    const fPropKey = Object.keys(props).find(k => k.toLowerCase().includes('final update')) || Config.SCHEMA.FINAL_UPDATE.name;
    const fRange = getSafeDateRange(props[fPropKey]);
    const hasFinalUpdate = !!(fRange && fRange.start);

    // 이벤트성 일정 보호: 이미 지난 날짜의 "하루짜리(Progress 없음)" 일정은 수식이 "오늘"이라고 해도 오늘로 늘리지 않는다.
    //   (한국시간 00~09시엔 수식이 UTC 기준이라 어제가 "오늘"로 보여, 하루짜리 이벤트가 다음 날에도 붙던 문제)
    if (isActiveToday && startStr === endStr && endStr < todayISO && !hasProgress(props)) {
        isActiveToday = false;
        detectReason = '';
    }

    if (isActiveToday) {
        finalEndStr = todayISO;
    } else if (hasFinalUpdate) {
        finalEndStr = fRange.start;
    }

    if (startStr > finalEndStr) finalEndStr = startStr;
    return { start: startStr, end: finalEndStr, isActiveToday, detectReason };
}

function getDaysArray(start, end) {
    const arr = [];
    let curr = DateTime.fromISO(start);
    const last = DateTime.fromISO(end);
    let safety = 0;
    while (curr <= last && safety < 1200) {
        arr.push(curr.toISODate());
        curr = curr.plus({ days: 1 });
        safety++;
    }
    return arr;
}

// =====================================================================
// [실패 뱃지] 자동실행이 재시도까지 실패한 항목의 Note 속성에 경고 뱃지를 붙인다.
//  - 기존 Note 내용은 건드리지 않고 맨 앞에 뱃지만 덧붙인다(완전 대체 아님).
//  - 성공하면 뱃지만 골라서 제거하고, 그 외 Note 내용은 그대로 둔다.
//  - 마킹은 FAIL_BADGE_MARK 문자열로 식별하므로, 사용자가 우연히 같은
//    문구를 직접 적지 않는 한 다른 rich_text와 섞여도 안전하다.
// =====================================================================
const FAIL_BADGE_MARK = 'AutoBackupFail';

function makeFailBadge() {
    return {
        type: 'equation',
        equation: { expression: `\\fcolorbox{900000}{900000}{\\color{white}{\\enspace⚠ ${FAIL_BADGE_MARK}: 자동연결 실패 · 수동 연결 필요\\enspace}}` }
    };
}

function isFailBadge(rt) {
    return !!(rt && rt.type === 'equation' && rt.equation && typeof rt.equation.expression === 'string' && rt.equation.expression.includes(FAIL_BADGE_MARK));
}

async function markFailureBadge(notion, item) {
    const noteProp = item.properties[Config.SCHEMA.NOTE.name];
    if (!noteProp || noteProp.type !== 'rich_text') return;
    const current = noteProp.rich_text || [];
    if (current.some(isFailBadge)) return; // 이미 붙어있음
    try {
        await notion.pages.update({
            page_id: item.id,
            properties: { [Config.SCHEMA.NOTE.name]: { rich_text: [makeFailBadge(), { type: 'text', text: { content: ' ' } }, ...current] } }
        });
        debugLog(`  [Badge] 실패 뱃지 표시: ${getPageTitle(item)}`);
    } catch (e) {
        debugLog(`  [Badge] 실패 뱃지 표시 실패: ${e.message}`);
    }
}

// 환경변수 ID가 비어있으면 제목으로 DB를 찾아 자동 보정 (설정 실수 방지용 안전망)
async function getOrSearchDbId(notion, envId, keyword) {
    if (envId && envId.trim().length > 0) return envId.trim();
    try {
        const res = await notion.search({ filter: { property: 'object', value: 'database' } });
        const matched = res.results.find(db => {
            const rawTitle = (db.title || []).map(t => t.plain_text).join('');
            return rawTitle.replace(/20\d\d_Store/gi, '').trim().toLowerCase().includes(keyword.toLowerCase());
        });
        return matched ? matched.id : null;
    } catch (e) { return null; }
}

// =====================================================================
// executeSync - 메인 동기화 엔진 (v10 기반)
// =====================================================================
async function executeSync(params) {
  frontendLogs = [];
  const startedAt = Date.now();
  const overBudget = () => (Date.now() - startedAt) > RUN_BUDGET_MS;
  let MANUAL_START = (params.start_date || process.env.START_DATE || '').replace(/[^0-9-]/g, '');
  let MANUAL_END = (params.end_date || process.env.END_DATE || '').replace(/[^0-9-]/g, '');

  const MODE = (MANUAL_START && MANUAL_END) ? 'range' : (params.mode || process.env.MODE || 'today');
  const TARGET_DBS = params.target_dbs || 'all';
  // Timetable/Pomodoro는 Personal/Finance/Media와 별개의 체크박스라, target_dbs에
  // "all,timeline" 처럼 "all"과 나란히 섞여 들어올 수 있다. 그래서 "all" 포함 여부와
  // 개별 항목 목록을 따로 뽑아둔다 (문자열 전체가 정확히 'all'인지만 보지 않는다).
  const rawTargets = TARGET_DBS.split(',').map(s => s.trim()).filter(Boolean);
  const wantsAllMaster = TARGET_DBS === 'all' || rawTargets.includes('all');

  addLog(`🚀 동기화 시작 (모드: ${MODE})`);
  const now = DateTime.now().setZone('Asia/Seoul');
  const todayISO = now.toISODate();

  const { NOTION_TOKEN } = Config.ENV;
  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 30000, notionVersion: '2022-06-28' });

  // DB ID 자동 보정 (환경변수가 비어있을 때만 검색 - 정상 설정 시엔 그대로 통과)
  const [
      DAILY_DB_ID, WEEKLY_DB_ID, MONTHLY_DB_ID, ANNUAL_DB_ID, TIMELINE_DB_ID, POMODORO_DB_ID,
      FIN_WEEKLY_DB_ID, FIN_MONTHLY_DB_ID,
      PERSONAL_MASTER_DB_ID, FINANCE_MASTER_DB_ID, MEDIA_MASTER_DB_ID
  ] = await Promise.all([
      getOrSearchDbId(notion, Config.ENV.DAILY_DB_ID, 'Daily Archive'),
      getOrSearchDbId(notion, Config.ENV.WEEKLY_DB_ID, 'Weekly Archive'),
      getOrSearchDbId(notion, Config.ENV.MONTHLY_DB_ID, 'Monthly Archive'),
      getOrSearchDbId(notion, Config.ENV.ANNUAL_DB_ID, 'Annual'),
      getOrSearchDbId(notion, Config.ENV.TIMELINE_DB_ID, 'Time Table'),
      getOrSearchDbId(notion, Config.ENV.POMODORO_DB_ID, 'Pomodoro'),
      getOrSearchDbId(notion, Config.ENV.FIN_WEEKLY_DB_ID, 'Finance Weekly Archive'),
      getOrSearchDbId(notion, Config.ENV.FIN_MONTHLY_DB_ID, 'Finance Monthly Archive'),
      getOrSearchDbId(notion, Config.ENV.PERSONAL_MASTER_DB_ID, 'Personal Master'),
      getOrSearchDbId(notion, Config.ENV.FINANCE_MASTER_DB_ID, 'Finance Master'),
      getOrSearchDbId(notion, Config.ENV.MEDIA_MASTER_DB_ID, 'Media Master')
  ]);

  // ※ "오늘 24시간 타임라인 자동 생성/보정"은 이제 이 파일이 아니라
  //    /api/timeline.js (mode=auto, vercel.json에 별도 크론으로 매일 실행됨)가
  //    전담한다 - Schedule 정확도(정시~정시+1시간) 계산과 생성 로직을
  //    한 곳에서만 유지하기 위해 여기 있던 중복 구현은 제거했다.

  let queryStart, queryEnd;
  if (MODE === 'range' && MANUAL_START && MANUAL_END) {
      debugLog(`[Range] ${MANUAL_START} ~ ${MANUAL_END}`);
      queryStart = MANUAL_START;
      queryEnd = MANUAL_END;
  } else if (MODE === 'today') {
      queryStart = now.minus({ days: 7 }).toISODate();
      queryEnd = now.plus({ days: 7 }).toISODate();
      debugLog(`[Today] ${todayISO} (buf: ${queryStart} ~ ${queryEnd})`);
  } else if (MODE === 'recent' || MODE === 'recent_keep') {
      queryStart = now.minus({ months: 3 }).toISODate();
      queryEnd = now.plus({ months: 2 }).toISODate();
      debugLog(`[${MODE === 'recent_keep' ? 'Recent-Keep' : 'Recent'}] ${queryStart} ~ ${queryEnd}`);
  } else {
      queryStart = now.minus({ weeks: 3 }).toISODate();
      queryEnd = now.plus({ weeks: 2 }).toISODate();
      debugLog(`[Default] ${queryStart} ~ ${queryEnd}`);
  }

  // =====================================================================
  // [Checkpoint] 이어달리기 초기화 (MODE 'today' + 자동실행(slot 있음)일 때만 동작)
  // =====================================================================
  const cycleId = (MODE === 'today') ? makeCycleId(params) : null;
  const cp = await initCheckpoint(notion, cycleId);
  if (cp.enabled && cp.status === 'done') {
      addLog(`ℹ️ 이번 시간대(${cycleId}) 동기화는 이미 완료되어 있어 건너뜁니다.`);
      return { status: 'skipped', cycleId };
  }
  if (cp.enabled) {
      debugLog(`[Checkpoint] '${cycleId}' 시작/이어감 (이미 완료: ${cp.completed.join(', ') || '없음'})`);
  } else if (cycleId) {
      debugLog(`[Checkpoint] 상태DB 미설정 → 체크포인트 없이 전체 실행`);
  }

  // 시간 예산 초과로 중단될 때 사용자에게 보여줄 공통 안내 (기술적 사유는 debugLog로만)
  const pauseNotice = (phase) => {
      debugLog(`[Checkpoint] 시간예산(${RUN_BUDGET_MS}ms) 초과 (phase: ${phase}) → 다음 실행이 이어감`);
      addLog(`⏸️ 처리 시간이 길어 일부만 완료했습니다. 나머지는 잠시 후 자동으로 이어집니다.`);
  };

  // =====================================================================
  // [Chain] 최근 7일 Daily ID 조회 (1~2일 자동실행 실패해도 체인 유지)
  // =====================================================================
  let recentDailyIds = [];
  if ((MODE === 'today' || MODE === 'recent' || MODE === 'recent_keep') && DAILY_DB_ID) {
      try {
          const chainStart = now.minus({ days: 7 }).toISODate();
          const ydRes = await notion.databases.query({
              database_id: DAILY_DB_ID,
              filter: {
                  and: [
                      { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_after: chainStart } },
                      { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_before: todayISO } }
                  ]
              },
              page_size: 10
          });
          recentDailyIds = ydRes.results.map(p => p.id);
          debugLog(`[Chain] ${recentDailyIds.length} daily (7d)`);
          await delay(100);
      } catch (e) {
          debugLog(`[Chain] fail: ${e.message}`);
      }
  }

  let allTargetDbs = [
    { id: PERSONAL_MASTER_DB_ID, name: "Personal", key: "personal" },
    { id: FINANCE_MASTER_DB_ID, name: "Finance", key: "finance" },
    { id: MEDIA_MASTER_DB_ID, name: "Media", key: "media" }
  ];

  if (!wantsAllMaster) {
      allTargetDbs = allTargetDbs.filter(db => rawTargets.includes(db.key));
  }

  // [Checkpoint] 이미 동기화를 끝낸 마스터 DB는 이번 실행에서 건너뛴다
  if (cp.enabled && cp.completed.length > 0) {
      allTargetDbs = allTargetDbs.filter(db => !cp.completed.includes(db.key));
      debugLog(`[Checkpoint] 남은 마스터 DB: ${allTargetDbs.map(d => d.name).join(', ') || '없음'}`);
  }

  const tasksToSync = [];
  let minRefDate = queryStart;
  let maxRefDate = queryEnd;
  const searchStart = DateTime.fromISO(queryStart).minus({ days: 7 }).toISODate();

  // =====================================================================
  // DB별 일정 스캔
  // =====================================================================
  for (const db of allTargetDbs) {
      if (!db.id) continue;

      if (cp.enabled && overBudget()) {
          pauseNotice('scan');
          await saveCheckpoint(notion, cp, { status: 'paused', phase: 'scan' });
          return { status: 'paused', cycleId: cp.cycleId, completed: cp.completed };
      }

      debugLog(`\n[${db.name}] scan...`);

      let dbInfo;
      try {
          dbInfo = await notion.databases.retrieve({ database_id: db.id });
          await delay(150);
      } catch (e) {
          addLog(`❌ ${db.name} Master DB 연결 실패 (ID/권한 확인 필요): ${e.message}`);
          continue;
      }

      const props = dbInfo.properties;
      const schedPropKey = Object.keys(props).find(k => k.toLowerCase() === 'schedule') || Config.SCHEMA.SCHEDULE.name;
      const todayPropKey = Object.keys(props).find(k => k.toLowerCase().includes('today'));
      const backupPropKey = Object.keys(props).find(k => k.toLowerCase() === 'backup') || Config.SCHEMA.BACKUP.name;

      let orConditions = [
          {
              and: [
                  { property: schedPropKey, date: { on_or_after: searchStart } },
                  { property: schedPropKey, date: { on_or_before: queryEnd } }
              ]
          }
      ];

      if (todayPropKey && props[todayPropKey]?.type === 'formula') {
          orConditions.push({ property: todayPropKey, formula: { string: { contains: "today" } } });
          orConditions.push({ property: todayPropKey, formula: { string: { contains: "Today" } } });
      }

      const dynamicTargetDbFilter = { or: orConditions };
      let items = [];
      let hasMore = true; let cursor = undefined;

      while (hasMore) {
          let attempt = 0, success = false;
          while (attempt < 3 && !success) {
              try {
                  const res = await notion.databases.query({
                      database_id: db.id, filter: dynamicTargetDbFilter,
                      sorts: [{ property: schedPropKey, direction: "descending" }],
                      page_size: 100, start_cursor: cursor
                  });
                  items = [...items, ...res.results];
                  hasMore = res.has_more; cursor = res.next_cursor; success = true;
                  await delay(150);
              } catch (e) {
                  attempt++;
                  debugLog(`  [Retry ${attempt}/3] ${e.code}`);
                  if (e.code === 'validation_error') { hasMore = false; break; }
                  await delay(1500 * attempt);
              }
          }
          if (!success && hasMore) break;
      }

      items = items.filter(item => {
          const taskRange = calculateTaskRange(item, db.name);
          if (!taskRange) return false;

          if (MODE === 'today') {
              const coversToday = (taskRange.start <= todayISO && taskRange.end >= todayISO);
              if (taskRange.isActiveToday || coversToday) {
                  if (taskRange.start < minRefDate) minRefDate = taskRange.start;
                  if (taskRange.end > maxRefDate) maxRefDate = taskRange.end;
                  return true;
              }
              return false;
          }

          if (taskRange.start <= queryEnd && taskRange.end >= queryStart) {
              if (taskRange.start < minRefDate) minRefDate = taskRange.start;
              if (taskRange.end > maxRefDate) maxRefDate = taskRange.end;
              return true;
          }
          return false;
      });

      debugLog(`  ${items.length} items`);

      // =====================================================================
      // [Chain Query] Today+Recent: 최근 7일 Daily가 Backup에 있는 일정 포착
      // =====================================================================
      if ((MODE === 'today' || MODE === 'recent' || MODE === 'recent_keep') && recentDailyIds.length > 0 && backupPropKey && props[backupPropKey] && db.name !== 'Finance') {
          try {
              const chainFilters = recentDailyIds.map(id => ({
                  property: backupPropKey,
                  relation: { contains: id }
              }));
              const chainFilter = chainFilters.length === 1 ? chainFilters[0] : { or: chainFilters };

              let chainItems = [];
              let chainHasMore = true, chainCursor = undefined;
              while (chainHasMore) {
                  const chainRes = await notion.databases.query({
                      database_id: db.id,
                      filter: chainFilter,
                      page_size: 100, start_cursor: chainCursor
                  });
                  chainItems = [...chainItems, ...chainRes.results];
                  chainHasMore = chainRes.has_more; chainCursor = chainRes.next_cursor;
                  await delay(150);
              }

              debugLog(`  [Chain] 후보 ${chainItems.length}개: ${chainItems.map(c => getPageTitle(c)).join(', ') || '(없음)'}`);

              const existingIds = new Set(items.map(i => i.id));
              let chainCount = 0;

              for (const ci of chainItems) {
                  const ciTitle = getPageTitle(ci);
                  if (existingIds.has(ci.id)) continue;

                  const ciProps = ci.properties;
                  const ciSchedRange = getSafeDateRange(ciProps[schedPropKey]);
                  if (!ciSchedRange || !ciSchedRange.start) { debugLog(`    [Chain skip] ${ciTitle}: Schedule 없음/무효`); continue; }

                  if (ciSchedRange.start > todayISO) { debugLog(`    [Chain skip] ${ciTitle}: Schedule 시작일이 미래(${ciSchedRange.start})`); continue; }

                  // 1일 고정 일정(start===end)이면서 이미 지난 날짜(유예 없음): Progress 가 비어 있으면 하루짜리
                  // 이벤트로 보고 체인 제외, Progress 가 있으면 진행 중인 참조 페이지로 보고 체인 유지
                  if (ciSchedRange.start === ciSchedRange.end && ciSchedRange.end < todayISO) {
                      if (!hasProgress(ciProps)) {
                          debugLog(`    [Chain skip] ${ciTitle}: 하루짜리+지난날+Progress비어있음`);
                          continue;
                      }
                  }

                  const fKey = Object.keys(ciProps).find(k => k.toLowerCase().includes('final update'));
                  const fProp = fKey ? ciProps[fKey] : null;
                  const cfRange = getSafeDateRange(fProp);
                  if (cfRange && cfRange.start) { debugLog(`    [Chain skip] ${ciTitle}: Final Update 있음(${cfRange.start})`); continue; }

                  ci._chainRange = {
                      start: ciSchedRange.start,
                      end: todayISO,
                      isActiveToday: true,
                      detectReason: 'Chain'
                  };
                  items.push(ci);
                  chainCount++;

                  if (ci._chainRange.start < minRefDate) minRefDate = ci._chainRange.start;
                  if (todayISO > maxRefDate) maxRefDate = todayISO;
              }

              if (chainCount > 0) {
                  debugLog(`  🔗 [Chain] +${chainCount}`);
              }
          } catch (e) {
              debugLog(`  [Chain ERR] ${e.message}`);
          }
      }

      tasksToSync.push({ db, items, backupPropKey });
  }

  // =====================================================================
  // 참조 DB 로딩 + 동기화 실행
  // =====================================================================
  if (tasksToSync.length > 0) {
      debugLog(`\n[RefDB] loading...`);

      let safeRefStart = DateTime.fromISO(minRefDate).minus({ days: 7 }).toISODate();
      const maxSafetyFloor = now.minus({ months: 12 }).toISODate();
      if (safeRefStart < maxSafetyFloor) safeRefStart = maxSafetyFloor;

      const refEnd = DateTime.fromISO(maxRefDate).plus({ days: 7 }).toISODate();

      const refFilter = {
          and: [
              { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_after: safeRefStart } },
              { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_before: refEnd } }
          ]
      };

      const loadRefDB = async (dbId, name) => {
        if (!dbId) return [];
        let allResults = []; let hasMore = true; let cursor = undefined;
        while (hasMore) {
            let attempt = 0, success = false;
            while (attempt < 3 && !success) {
                try {
                    const res = await notion.databases.query({
                        database_id: dbId, filter: refFilter,
                        sorts: [{ property: Config.SCHEMA.SCHEDULE.name, direction: "descending" }],
                        page_size: 100, start_cursor: cursor
                    });
                    allResults = [...allResults, ...res.results];
                    hasMore = res.has_more; cursor = res.next_cursor; success = true;
                    await delay(150);
                } catch (e) {
                    attempt++;
                    if (e.code === 'validation_error') { hasMore = false; break; }
                    await delay(2000 * attempt);
                }
            }
            if (!success && hasMore) break;
        }
        return allResults;
      };

      const hasFin = tasksToSync.some(g => g.db.name === "Finance");
      const hasNonFin = tasksToSync.some(g => g.db.name !== "Finance");
      const needMainRefs = hasNonFin || hasFin;

      // [Year Check] Annual DB는 연 1건뿐이라 row 수가 적음 -> 날짜창 없이 전체를 그냥 로드
      const loadAnnualDB = async (dbId) => {
          if (!dbId) return [];
          let allResults = []; let hasMore = true; let cursor = undefined;
          while (hasMore) {
              try {
                  const res = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor });
                  allResults = [...allResults, ...res.results];
                  hasMore = res.has_more; cursor = res.next_cursor;
                  await delay(150);
              } catch (e) {
                  addLog(`⚠️ Annual DB 연결 실패로 Year Check 연결을 건너뜁니다: ${e.message}`);
                  hasMore = false;
              }
          }
          return allResults;
      };

      const [dailyRaw, weekly, monthly, finWeekly, finMonthly, annual] = await Promise.all([
          loadRefDB(DAILY_DB_ID, "Daily DB"),
          needMainRefs ? loadRefDB(WEEKLY_DB_ID, "Main-Weekly") : Promise.resolve([]),
          needMainRefs ? loadRefDB(MONTHLY_DB_ID, "Main-Monthly") : Promise.resolve([]),
          hasFin ? loadRefDB(FIN_WEEKLY_DB_ID, "Fin-Weekly") : Promise.resolve([]),
          hasFin ? loadRefDB(FIN_MONTHLY_DB_ID, "Fin-Monthly") : Promise.resolve([]),
          needMainRefs ? loadAnnualDB(ANNUAL_DB_ID) : Promise.resolve([])
      ]);

      debugLog(`  Daily:${dailyRaw.length} W:${weekly.length} M:${monthly.length} Y:${annual.length}`);
      if (hasFin) debugLog(`  FinW:${finWeekly.length} FinM:${finMonthly.length}`);

      const dailyMap = new Map();
      dailyRaw.forEach(page => {
          const d = getSafeDateRange(page.properties[Config.SCHEMA.SCHEDULE.name]);
          if (d && d.start) dailyMap.set(d.start, page.id);
      });

      const refMap = { weekly, monthly, finWeekly, finMonthly, annual };
      const findDailyIdInMemory = (dateStr) => dailyMap.get(dateStr) || null;

      const findOverlappingIds = (taskStart, taskEnd, dbType) => {
          const candidates = refMap[dbType] || [];
          const matchedIds = [];
          for (const p of candidates) {
              const d = getSafeDateRange(p.properties[Config.SCHEMA.SCHEDULE.name]);
              if (!d) continue;
              let pStart = d.start; let pEnd = d.end;
              if (pStart === pEnd) {
                  if (dbType.includes('weekly') || dbType.includes('Weekly')) pEnd = DateTime.fromISO(pStart).plus({ days: 6 }).toISODate();
                  else if (dbType.includes('monthly') || dbType.includes('Monthly')) pEnd = DateTime.fromISO(pStart).endOf('month').toISODate();
                  else if (dbType === 'annual') pEnd = DateTime.fromISO(pStart).endOf('year').toISODate();
              }
              if (taskStart <= pEnd && taskEnd >= pStart) matchedIds.push(p.id);
          }
          return matchedIds;
      };

      // 최근 7일 Daily ID 셋 (Recent 모드 진행 중 프로젝트 보호용)
      const recentDailyIdSet = new Set();
      for (let d = 0; d <= 7; d++) {
          const id = findDailyIdInMemory(now.minus({ days: d }).toISODate());
          if (id) recentDailyIdSet.add(id);
      }

      // =====================================================================
      // 동기화 실행
      // =====================================================================
      for (const group of tasksToSync) {
        if (cp.enabled && overBudget()) {
            pauseNotice('sync');
            await saveCheckpoint(notion, cp, { status: 'paused', phase: 'sync' });
            return { status: 'paused', cycleId: cp.cycleId, completed: cp.completed };
        }

        const db = group.db;
        const items = group.items;
        const groupBackupKey = group.backupPropKey;

        // 사용자 화면용 집계 (개별 항목 로그 대신 DB당 요약 1줄 + 실패 목록만 노출)
        let syncedCount = 0;
        let passCount = 0;
        const failedItems = [];

        const BATCH_SIZE = 3;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            if (cp.enabled && overBudget()) {
                debugLog(`[Checkpoint] ${db.name} 동기화 일부만 완료 (${i}/${items.length}개)`);
                pauseNotice('sync');
                await saveCheckpoint(notion, cp, { status: 'paused', phase: 'sync' });
                return { status: 'paused', cycleId: cp.cycleId, completed: cp.completed };
            }
            const batch = items.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (item) => {
                const isFin = (db.name === "Finance");
                const title = getPageTitle(item);
                const taskRange = item._chainRange || calculateTaskRange(item, db.name);
                if (!taskRange) return;

                let linkTargetRange = taskRange;

                if ((MODE === 'recent' || MODE === 'recent_keep') && !linkTargetRange.isActiveToday
                    && linkTargetRange.start !== linkTargetRange.end
                    && linkTargetRange.end < todayISO) {
                    const fKey = Object.keys(item.properties).find(k => k.toLowerCase().includes('final update'));
                    const fRange2 = fKey ? getSafeDateRange(item.properties[fKey]) : null;
                    if (!fRange2 || !fRange2.start) {
                        const bKey = groupBackupKey || Config.SCHEMA.BACKUP.name;
                        const bProp = item.properties[bKey];
                        if (bProp && bProp.relation && bProp.relation.length > 0) {
                            const hasRecentBackup = bProp.relation.some(r => recentDailyIdSet.has(r.id));
                            if (hasRecentBackup) {
                                linkTargetRange = {
                                    ...linkTargetRange,
                                    end: todayISO,
                                    isActiveToday: true,
                                    detectReason: 'Ongoing'
                                };
                            }
                        }
                    }
                }

                const updatePayload = {};

                const linkCore = (propName, dbType, isDaily = false) => {
                    const prop = item.properties[propName];
                    if (!prop || prop.type !== 'relation') return;

                    let newFoundIds = [];
                    if (isDaily) {
                        const days = getDaysArray(linkTargetRange.start, linkTargetRange.end);
                        newFoundIds = days.map(day => findDailyIdInMemory(day)).filter(id => id !== null);
                    } else {
                        newFoundIds = findOverlappingIds(linkTargetRange.start, linkTargetRange.end, dbType);
                    }

                    const currentIds = (prop.relation || []).map(r => r.id);
                    const currentIdSet = new Set(currentIds);

                    let finalIds = [];
                    if (MODE === 'range') {
                        finalIds = newFoundIds;
                    } else if (MODE === 'recent') {
                        const loadedIdSet = isDaily
                            ? new Set(dailyMap.values())
                            : new Set((refMap[dbType] || []).map(p => p.id));
                        const preservedOutsideIds = currentIds.filter(id => !loadedIdSet.has(id));
                        finalIds = Array.from(new Set([...preservedOutsideIds, ...newFoundIds]));
                    } else if (MODE === 'recent_keep') {
                        finalIds = Array.from(new Set([...currentIds, ...newFoundIds]));
                    } else {
                        finalIds = Array.from(new Set([...currentIds, ...newFoundIds]));
                    }

                    if (finalIds.length === 0 && MODE !== 'range') return;
                    if (finalIds.length > 100) finalIds = finalIds.slice(-100);

                    const isSame = finalIds.length === currentIdSet.size && finalIds.every(id => currentIdSet.has(id));
                    if (!isSame) updatePayload[propName] = { relation: finalIds.map(id => ({ id })) };
                };

                if (isFin) {
                    linkCore(Config.SCHEMA.BACKUP.name, "daily", true);
                    linkCore(Config.SCHEMA.MONTH_BACKUP.name, "monthly");
                    linkCore(Config.SCHEMA.WEEK_BACKUP.name, "weekly");
                    linkCore(Config.SCHEMA.MONTH_CHECK.name, "finMonthly");
                    linkCore(Config.SCHEMA.WEEK_CHECK.name, "finWeekly");
                } else {
                    linkCore(Config.SCHEMA.BACKUP.name, "daily", true);
                    linkCore(Config.SCHEMA.MONTH_CHECK.name, "monthly");
                    linkCore(Config.SCHEMA.WEEK_CHECK.name, "weekly");
                }

                // [Self Backup] Personal/Finance/Media 공통: 자기 자신을 Self Backup에 연결.
                //   페이지를 새로 만들 때 노션 자동화로 채워지는 게 기본이지만, 사용자가
                //   수동으로 만든 페이지 등에서 누락될 수 있어 여기서 한 번 더 보정한다.
                //   해당 DB에 "Self Backup" 속성이 없으면 조용히 무시된다.
                const selfProp = item.properties[Config.SCHEMA.SELF_BACKUP.name];
                if (selfProp && selfProp.type === 'relation') {
                    const currentSelf = (selfProp.relation || []).map(r => r.id);
                    if (!currentSelf.includes(item.id)) {
                        updatePayload[Config.SCHEMA.SELF_BACKUP.name] = { relation: [{ id: item.id }] };
                    }
                }
                // [Year Check] Personal/Finance/Media 공통 Annual DB 하나에 연결.
                //   대상 DB에 "Year Check" 속성이 없으면 linkCore가 조용히 무시한다.
                linkCore(Config.SCHEMA.YEAR_CHECK.name, "annual");

                // [실패 뱃지 정리] 예전에 실패 뱃지가 붙어있었다면, 이번에 다시 시도하면서 같이 지운다.
                //   (연결이 이미 최신 상태라 다른 변경이 없어도, 뱃지만 남아있으면 지우는 요청을 보낸다.)
                const noteProp = item.properties[Config.SCHEMA.NOTE.name];
                const hasBadge = !!(noteProp && noteProp.type === 'rich_text' && (noteProp.rich_text || []).some(isFailBadge));
                if (hasBadge) {
                    updatePayload[Config.SCHEMA.NOTE.name] = { rich_text: (noteProp.rich_text || []).filter(rt => !isFailBadge(rt)) };
                }

                const rawReason = item._chainRange ? item._chainRange.detectReason : (taskRange.detectReason || "");
                const reasonTag = rawReason ? ` ${reasonIcon(rawReason)}[${rawReason}]` : "";
                if (Object.keys(updatePayload).length > 0) {
                    try {
                        await notion.pages.update({ page_id: item.id, properties: updatePayload });
                        syncedCount++;
                        debugLog(`  [SYNCED] ${title} (${linkTargetRange.start}~${linkTargetRange.end})${reasonTag}`);
                        // 이번 사이클에서 실패로 기록해뒀던 게 있으면 지운다 (재연결 성공)
                        if (cp.enabled && cp.failedOnce && cp.failedOnce[item.id]) delete cp.failedOnce[item.id];
                        await delay(150);
                    } catch (e) {
                        failedItems.push({ title, error: e.message });
                        debugLog(`  [FAILED] ${title}: ${e.message}`);
                        // [실패 뱃지] 같은 자동실행 사이클(오늘 이 시간대 + 재시도) 안에서 두 번째로 실패한 경우에만 표시.
                        //   1차 시도 실패는 재시도가 알아서 고칠 수도 있으니 아직 표시하지 않는다.
                        if (cp.enabled) {
                            cp.failedOnce = cp.failedOnce || {};
                            if (cp.failedOnce[item.id]) {
                                await markFailureBadge(notion, item);
                            } else {
                                cp.failedOnce[item.id] = true;
                            }
                        }
                    }
                } else {
                    passCount++;
                    debugLog(`  [PASS] ${title} (${linkTargetRange.start}~${linkTargetRange.end})${reasonTag}`);
                }
            }));
            await delay(100);
        }

        // 사용자 화면용 요약: DB당 한 줄 + 실패 항목만 별도 표시
        addLog(`📂 ${db.name}: ${items.length}건 확인 → ✅ ${syncedCount}건 연결${passCount > 0 ? ` / ⏭ ${passCount}건 이상없음` : ''}${failedItems.length > 0 ? ` / ❌ ${failedItems.length}건 실패` : ''}`);
        failedItems.forEach(f => addLog(`   ❌ "${f.title}": ${f.error}`));

        if (cp.enabled) {
            if (!cp.completed.includes(db.key)) cp.completed.push(db.key);
            await saveCheckpoint(notion, cp, { status: 'paused', phase: 'sync' });
        }
      }
  }

  // =====================================================================
  // [Checkpoint] 시간 예산 초과 시: Timetable/Pomodoro 연동은 다음 실행으로 미룬다
  // =====================================================================
  if (cp.enabled && overBudget()) {
      debugLog(`[Checkpoint] Timetable/Pomodoro 연동은 다음 실행으로 미룸`);
      pauseNotice('subdb');
      await saveCheckpoint(notion, cp, { status: 'paused', phase: 'subdb' });
      return { status: 'paused', cycleId: cp.cycleId, completed: cp.completed };
  }

  // =====================================================================
  // Timetable / Pomodoro 연동 (Backup → Daily 관계형만 채우는 단순 연동)
  //  - Timetable: index.html의 별도 체크박스로 명시적으로 선택했을 때만 실행
  //    (일일 자동 생성/보정 자체는 /api/timeline?mode=auto 크론이 전담)
  //  - Pomodoro: "ALL"(일일 자동 실행 포함)일 때 항상 포함 + 별도 체크박스로도 선택 가능
  // =====================================================================
  const subDbsToLink = [];
  if (rawTargets.includes('timeline') && TIMELINE_DB_ID) subDbsToLink.push({ id: TIMELINE_DB_ID, name: "Timetable" });
  if ((wantsAllMaster || rawTargets.includes('pomodoro')) && POMODORO_DB_ID) subDbsToLink.push({ id: POMODORO_DB_ID, name: "Pomodoro" });

  if (subDbsToLink.length > 0) {
    const refStart = DateTime.fromISO(queryStart).minus({ days: 7 }).toISODate();
    const refEnd2 = DateTime.fromISO(queryEnd).plus({ days: 7 }).toISODate();

    let dailyRaw2 = [];
    try {
        const dailyRes = await notion.databases.query({
            database_id: DAILY_DB_ID,
            filter: { and: [ { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_after: refStart } }, { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_before: refEnd2 } } ] }
        });
        dailyRaw2 = dailyRes.results;
    } catch (e) {
        addLog(`⚠️ Daily Archive 조회 실패로 Timetable/Pomodoro 연동을 건너뜁니다: ${e.message}`);
    }

    const dailyMap2 = new Map();
    dailyRaw2.forEach(page => {
        const d = getSafeDateRange(page.properties[Config.SCHEMA.SCHEDULE.name]);
        if (d && d.start) dailyMap2.set(d.start, page.id);
    });
    const findDailyId2 = (dateStr) => dailyMap2.get(dateStr) || null;

    for (const subDb of subDbsToLink) {
      debugLog(`\n[SubDB] ${subDb.name}...`);
      try {
        let hasMore = true, cursor = undefined;
        let linked = 0, checked = 0, subFailed = 0;
        while (hasMore) {
          const subRes = await notion.databases.query({
            database_id: subDb.id,
            filter: {
              and: [
                { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_after: queryStart } },
                { property: Config.SCHEMA.SCHEDULE.name, date: { on_or_before: queryEnd } }
              ]
            },
            start_cursor: cursor, page_size: 100
          });
          for (const p of subRes.results) {
            checked++;
            const schedStart = p.properties[Config.SCHEMA.SCHEDULE.name]?.date?.start;
            if (!schedStart) continue;
            const dateStr = schedStart.substring(0, 10);

            const backupKey = Object.keys(p.properties).find(k => k.toLowerCase() === Config.SCHEMA.BACKUP.name.toLowerCase());
            const currentBackupIds = backupKey ? (p.properties[backupKey]?.relation || []).map(r => r.id) : [];

            // Timetable/Pomodoro 페이지는 하루의 특정 시간 하나에만 속하므로, Backup은
            // "그 날짜의 Daily 하나만" 정확히 있어야 한다. 부족분만 추가하면 예전에
            // 잘못 걸린 다른 날짜 Daily가 계속 같이 남아 중복이 쌓인다 - 그래서 "정확히
            // 이 하나만 있는지"를 확인해서 다르면 통째로 교체한다.
            const dailyId = findDailyId2(dateStr);
            const desiredIds = dailyId ? [dailyId] : [];
            const alreadyCorrect = currentBackupIds.length === desiredIds.length
                && currentBackupIds.every(id => desiredIds.includes(id));
            if (backupKey && !alreadyCorrect) {
              try {
                await notion.pages.update({ page_id: p.id, properties: { [backupKey]: { relation: desiredIds.map(id => ({ id })) } } });
                linked++;
                await delay(150);
              } catch (e) { subFailed++; debugLog(`  [ERR] ${subDb.name}: ${e.message}`); }
            }
          }
          hasMore = subRes.has_more; cursor = subRes.next_cursor;
          await delay(150);
        }
        addLog(`📂 ${subDb.name}: ${checked}건 확인 → ✅ ${linked}건 연결${subFailed > 0 ? ` / ❌ ${subFailed}건 실패` : ''}`);
      } catch (e) {
        addLog(`❌ ${subDb.name} 연동 실패: ${e.message}`);
      }
    }
  }

  addLog(`✅ 동기화 완료`);

  if (cp.enabled) {
      await saveCheckpoint(notion, cp, { status: 'done', phase: 'done' });
  }
  return { status: cp.enabled ? 'done' : 'full', cycleId: cp.cycleId };
}

module.exports = async (req, res) => {
  const { key } = req.query;
  // ✨ Vercel Cron 요청일 경우 비밀번호 무시하고 패스 (헤더 체크)
  //   Public 저장소는 사용자마다 WIDGET_SECRET이 달라 vercel.json에 key를 박아둘 수 없기 때문.
  const isCron = req.headers['user-agent'] === 'vercel-cron/1.0';

  if (!isCron && (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET)) {
      return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
  }

  try {
      const result = await executeSync(req.query || {});
      res.status(200).json({ success: true, result, logs: frontendLogs });
  }
  catch (err) {
      res.status(500).json({ error: err.message, logs: frontendLogs });
  }
};
