const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');
const Config = require('../lib/config');

let frontendLogs = [];
const addLog = (msg) => { console.log(msg); frontendLogs.push(msg); };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
// 시간대별 색상 + 아이콘 (개인용 타임라인 생성기와 같은 구조, Public 색상만 적용)
//   남색 #373c8a : 밤시간대 (0~6시)
//   노랑 #e3c8a6 : 보편적 여가시간대 (7~8시, 18~23시)
//   적색 #d39694 : 대부분의 업무시간대 (9~17시)
//   0/8/12/17/23시는 "채운" 박스로 구분(자정/아침/점심/퇴근), 나머지는 테두리만.
// =====================================================================
const COLOR_NIGHT = '373c8a';
const COLOR_LEISURE = 'e3c8a6';
const COLOR_WORK = 'd39694';
const FILLED_HOURS = new Set([0, 8, 12, 17, 23]);

function hourColor(h) {
    if (h <= 6) return COLOR_NIGHT;
    if (h <= 8 || h >= 18) return COLOR_LEISURE;
    return COLOR_WORK;
}

// 노션 자체 아이콘과 유사한 lucide 시계 아이콘(1~12시 방향)을 시간에 맞게 적용.
function getClockIcon(hour) {
    const clockNum = hour % 12 || 12;
    const isDaytime = hour >= 6 && hour <= 17;
    const color = isDaytime ? '%23999999' : '%23333333';
    return `https://api.iconify.design/lucide/clock-${clockNum}.svg?color=${color}`;
}

// 원본 템플릿(노션 페이지 템플릿)의 실제 규칙: 시/분 자릿수가 한 자리(0~8시)면 앞뒤로
// \enspace 여백을 넣고, 자릿수가 바뀌는 9시(9:00-10:00)는 \thickspace/\thinspace로
// 비대칭 보정하며, 두 자리(10~23시)는 여백을 아예 넣지 않는다 - 글자 수 차이만큼
// 여백으로 상쇄해서 칸 너비를 전부 동일하게 맞추기 위함이다. 모든 시간에 똑같이
// \enspace를 넣으면(예전 방식) 두 자리 시간대부터 칸이 넓어져 버린다.
function paddedLabel(h) {
    const label = `${h}:00-${h + 1}:00`;
    if (h <= 8) return `\\enspace${label}\\enspace`;
    if (h === 9) return `\\thickspace${label}\\thinspace`;
    return label;
}

// 제목에 쓸 컬러 박스 수식(이퀘이션) 블록을 만든다.
// 예: \fcolorbox{373c8a}{373c8a}{\color{ffffff}{\enspace0:00-1:00\enspace}}
function makeHourTitle(h) {
    const color = hourColor(h);
    const label = paddedLabel(h);
    const expression = FILLED_HOURS.has(h)
        ? `\\fcolorbox{${color}}{${color}}{\\color{ffffff}{${label}}}`
        : `\\fcolorbox{${color}}{ffffff}{\\color{${color}}{${label}}}`;
    return [{ type: 'equation', equation: { expression } }];
}

function titleEquals(currentArr, expectedArr) {
    const a = currentArr || [];
    if (a.length !== expectedArr.length) return false;
    return a.every((rt, i) => {
        const exp = expectedArr[i];
        if (rt.type !== exp.type) return false;
        if (rt.type === 'equation') return rt.equation?.expression === exp.equation?.expression;
        return true;
    });
}

// 페이지 제목에서 시간을 알아낸다. 컬러 이퀘이션(새 형식: "H:00-H:00")과, 예전 버전에서
// 만들어진 일반 텍스트("MM-DD HH:00") 둘 다 인식한다 - 예전 형식으로 이미 만들어진
// 페이지도 새로 만들지 않고 찾아서 이번 기회에 새 형식으로 갱신(마이그레이션)한다.
function extractHourFromTitle(page, titlePropName) {
    const titleArr = page.properties[titlePropName]?.title;
    if (!titleArr || titleArr.length === 0) return null;
    const text = titleArr.map(t => t.plain_text || (t.type === 'equation' ? t.equation.expression : '')).join('');
    let match = text.match(/(\d{1,2})\s*:\s*00\s*-\s*\d{1,2}\s*:\s*00/);
    if (match) return parseInt(match[1], 10);
    match = text.match(/^\d{2}-\d{2}\s+(\d{2}):00$/);
    if (match) return parseInt(match[1], 10);
    return null;
}

// 개인용 타임라인 생성기와 동일한 방식: Luxon의 zone 변환 대신 순수 Date 연산 +
// 수동 KST(+09:00) 오프셋 문자열 구성을 쓴다. (Luxon의 zone 기반 변환이 이 서버
// 환경에서 기대와 다르게 동작해 시간이 누락되는 문제가 있어, 검증된 방식으로 교체)
const toKSTISOString = (dateObj) => {
    const kstObj = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
    return kstObj.toISOString().substring(0, 19) + '+09:00';
};

// 정시~정시+1시간(정확히 60분)짜리 KST 구간을 만든다.
//   ※ 정시~:59분 방식은 각 시간 사이에 1분씩 빈틈이 생겨 합계 계산이 어긋나므로 사용하지 않는다.
function hourSlotRange(dateISO, hour) {
    const physicalDateObj = new Date(dateISO + "T00:00:00+09:00");
    const startObj = new Date(physicalDateObj.getTime() + hour * 3600 * 1000);
    const endObj = new Date(startObj.getTime() + 60 * 60 * 1000);
    return { start: toKSTISOString(startObj), end: toKSTISOString(endObj) };
}

async function findDailyPageId(notion, dailyDbId, dateISO, schedPropName) {
    if (!dailyDbId) return null;
    try {
        const res = await notion.databases.query({
            database_id: dailyDbId,
            filter: { property: schedPropName, date: { equals: dateISO } },
            page_size: 1
        });
        return res.results[0]?.id || null;
    } catch (e) { return null; }
}

// =====================================================================
// 하루치 24시간 타임라인을 점검한다.
//  - 없는 시간대는 새로 만든다 (컬러 제목 + 시간대별 시계 아이콘).
//  - 이미 있으면: 제목이 표준 형식이 아니면 새 형식으로 갱신(예전 버전 페이지 마이그레이션
//    포함), 아이콘도 다시 맞추고, Schedule이 정확한 정시~정시+1시간이 아니면 고치고,
//    Backup이 그 날짜의 Daily 페이지 "정확히 하나만" 있는 상태가 아니면(누락이든 중복이든)
//    바로잡는다.
//  - "자동 생성분"인지 판별하는 기준은 제목에서 "H:00-H:00" 형태의 시간 범위를 추출할 수
//    있는지 여부뿐이다. 사용자가 편의상 만든 페이지(예: "11:30-12:00" 같은 30분 단위
//    커스텀 제목)는 이 형식과 다르므로 절대 건드리지 않는다.
// =====================================================================
async function scanAndFixDay(notion, timelineDbId, dailyDbId, dateISO, schedPropName, titlePropName, backupPropName) {
    // Notion API는 시간 없는 날짜 문자열로 datetime 속성을 필터링할 때 UTC 기준으로
    // 해석해, KST 기준 하루 경계가 몇 시간 밀릴 수 있다. 그래서 개인용과 동일하게
    // 앞뒤로 하루씩 넉넉히 걸쳐 조회한 뒤, 실제 반환된 페이지의 물리적 날짜를
    // dateISO와 문자열로 직접 대조해서만 "오늘 것"으로 인정한다 (아래 physicalDateStr 체크).
    const prevDateStr = toKSTISOString(new Date(new Date(dateISO + "T00:00:00+09:00").getTime() - 24 * 3600 * 1000)).substring(0, 10);
    const nextDateStr = toKSTISOString(new Date(new Date(dateISO + "T00:00:00+09:00").getTime() + 24 * 3600 * 1000)).substring(0, 10);

    let existingPages = [];
    let hasMore = true, cursor = undefined;
    while (hasMore) {
        const res = await notion.databases.query({
            database_id: timelineDbId,
            filter: { and: [
                { property: schedPropName, date: { on_or_after: prevDateStr } },
                { property: schedPropName, date: { on_or_before: nextDateStr } }
            ] },
            start_cursor: cursor, page_size: 100
        });
        existingPages = existingPages.concat(res.results);
        hasMore = res.has_more; cursor = res.next_cursor;
        await delay(120);
    }

    const byHour = new Map();
    existingPages.forEach(p => {
        const h = extractHourFromTitle(p, titlePropName);
        const physicalDateStr = p.properties[schedPropName]?.date?.start?.substring(0, 10);
        if (h !== null && h >= 0 && h <= 23 && physicalDateStr === dateISO && !byHour.has(h)) byHour.set(h, p);
    });

    const dailyPageId = await findDailyPageId(notion, dailyDbId, dateISO, schedPropName);

    let created = 0, fixed = 0, skipped = 0;
    for (let h = 0; h < 24; h++) {
        const { start, end } = hourSlotRange(dateISO, h);
        const page = byHour.get(h);
        const expectedTitle = makeHourTitle(h);
        const iconUrl = getClockIcon(h);

        if (!page) {
            const properties = {
                [titlePropName]: { title: expectedTitle },
                [schedPropName]: { date: { start, end } }
            };
            if (dailyPageId && backupPropName) properties[backupPropName] = { relation: [{ id: dailyPageId }] };
            try {
                await notion.pages.create({
                    parent: { database_id: timelineDbId },
                    properties,
                    icon: { type: 'external', external: { url: iconUrl } }
                });
                created++;
            } catch (e) {
                addLog(`  ❌ [${h}시] 생성 실패: ${e.message}`);
            }
        } else {
            const sched = page.properties[schedPropName]?.date;
            // 개인용과 동일하게, 문자열 파싱 라이브러리에 의존하지 않고 원본 문자열만
            // 본다: 시간이 아예 없거나(date-only), 분(分)이 "00"이 아니면(예전 :59
            // 방식 등) 무조건 "정확하지 않음"으로 보고 고친다.
            const isExactTime = !!(sched && sched.start && sched.end
                && sched.start.includes('T') && sched.end.includes('T')
                && sched.start.substring(14, 16) === '00'
                && sched.end.substring(14, 16) === '00');

            const currentBackupIds = backupPropName ? (page.properties[backupPropName]?.relation || []).map(r => r.id) : [];
            const desiredBackupIds = dailyPageId ? [dailyPageId] : [];
            // "누락된 것만 추가"가 아니라 "정확히 이 하나만 있는지"를 확인한다.
            // 그래야 예전에 잘못 누적된 중복 Backup(예: 지난달 것 + 이번달 것)도
            // 다음 실행 때 자동으로 정리된다.
            const backupMatches = currentBackupIds.length === desiredBackupIds.length
                && currentBackupIds.every(id => desiredBackupIds.includes(id));
            const needsBackupFix = !!(backupPropName && !backupMatches);

            const titleMatches = titleEquals(page.properties[titlePropName]?.title, expectedTitle);
            const iconMatches = page.icon?.type === 'external' && page.icon.external?.url === iconUrl;

            if (!isExactTime || needsBackupFix || !titleMatches || !iconMatches) {
                const updateProps = {};
                if (!isExactTime) updateProps[schedPropName] = { date: { start, end } };
                if (needsBackupFix) updateProps[backupPropName] = { relation: desiredBackupIds.map(id => ({ id })) };
                if (!titleMatches) updateProps[titlePropName] = { title: expectedTitle };
                const updatePayload = { page_id: page.id, properties: updateProps };
                if (!iconMatches) updatePayload.icon = { type: 'external', external: { url: iconUrl } };
                try {
                    await notion.pages.update(updatePayload);
                    fixed++;
                } catch (e) {
                    addLog(`  ❌ [${h}시] 수정 실패: ${e.message}`);
                }
            } else {
                skipped++;
            }
        }
        await delay(120);
    }

    return { created, fixed, skipped };
}

module.exports = async (req, res) => {
    const { key, mode, date, start_date, end_date } = req.query;
    // ✨ Vercel Cron 요청일 경우 비밀번호 무시하고 패스 (헤더 체크)
    const isCron = req.headers['user-agent'] === 'vercel-cron/1.0';

    if (!isCron && (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET)) {
        return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
    }

    frontendLogs = [];

    try {
        const NOTION_TOKEN = process.env.NOTION_TOKEN;
        const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 55000, notionVersion: '2022-06-28' });

        const [timelineDbId, dailyDbId] = await Promise.all([
            getOrSearchDbId(notion, Config.ENV.TIMELINE_DB_ID, 'Time Table'),
            getOrSearchDbId(notion, Config.ENV.DAILY_DB_ID, 'Daily Archive')
        ]);

        if (!timelineDbId) {
            return res.status(200).json({ success: false, error: "Time Table(Timeline) DB를 찾을 수 없습니다.", logs: frontendLogs });
        }

        const dbInfo = await notion.databases.retrieve({ database_id: timelineDbId });
        const props = dbInfo.properties;
        const titlePropName = Object.keys(props).find(k => props[k].type === 'title') || Config.SCHEMA.TITLE.name;
        const schedPropName = Object.keys(props).find(k => k.toLowerCase() === Config.SCHEMA.SCHEDULE.name.toLowerCase()) || Config.SCHEMA.SCHEDULE.name;
        const backupPropName = Object.keys(props).find(k => k.toLowerCase() === Config.SCHEMA.BACKUP.name.toLowerCase()) || Config.SCHEMA.BACKUP.name;

        if (mode === 'auto' || mode === 'day') {
            const targetDate = (mode === 'auto') ? DateTime.now().setZone('Asia/Seoul').toISODate() : date;
            if (!targetDate) return res.status(400).json({ success: false, error: "date 파라미터가 필요합니다." });

            addLog(`🕐 [Timeline] ${targetDate} 24시간 점검 중...`);
            const { created, fixed, skipped } = await scanAndFixDay(notion, timelineDbId, dailyDbId, targetDate, schedPropName, titlePropName, backupPropName);
            addLog(`✨ ${targetDate}: 생성 ${created}개 / 수정 ${fixed}개 / 이상없음 ${skipped}개`);

            return res.status(200).json({
                success: true,
                message: `생성 ${created}개 / 수정 ${fixed}개 / 이상없음 ${skipped}개`,
                logs: frontendLogs
            });
        }

        return res.status(400).json({ success: false, error: `지원하지 않는 mode 입니다: ${mode || '(없음)'}`, logs: frontendLogs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message, logs: frontendLogs });
    }
};
