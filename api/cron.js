const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');

let frontendLogs = [];
function addLog(msg) { console.log(msg); frontendLogs.push(msg); }

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getPageTitle(item) {
    const titleProp = Object.values(item.properties).find(p => p.type === 'title');
    return titleProp?.title[0]?.plain_text || "제목없음";
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

function calculateTaskRange(item, dbName) {
    const props = item.properties;
    const schedKey = Object.keys(props).find(k => k.toLowerCase() === 'schedule');
    const schedProp = schedKey ? props[schedKey] : null;
    const schedRange = getSafeDateRange(schedProp);
    
    if (!schedRange) return null;
    return { start: schedRange.start, end: schedRange.end };
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

// ✨ 하이브리드 DB 검색 (우선순위: 환경변수 ID -> 정규식 키워드 탐색)
async function getOrSearchDbId(notion, envId, keyword) {
    if (envId && envId.trim().length > 0) return envId.trim();
    
    try {
        const res = await notion.search({ filter: { property: 'object', value: 'database' } });
        const matched = res.results.find(db => {
            const titleArr = db.title || [];
            const rawTitle = titleArr.map(t => t.plain_text).join('');
            // 2027_Store 등 연도_Store 패턴 제거
            const cleanTitle = rawTitle.replace(/20\d\d_Store/gi, '').trim().toLowerCase();
            return cleanTitle.includes(keyword.toLowerCase());
        });
        return matched ? matched.id : null;
    } catch (e) {
        return null;
    }
}

async function executeSync(params) {
    frontendLogs = [];
    let MANUAL_START = (params.start_date || process.env.START_DATE || '').replace(/[^0-9-]/g, '');
    let MANUAL_END = (params.end_date || process.env.END_DATE || '').replace(/[^0-9-]/g, '');
    
    const MODE = (MANUAL_START && MANUAL_END) ? 'range' : (params.mode || process.env.MODE || 'today');
    const TARGET_DBS = params.target_dbs || 'all';

    addLog(`🟢 [INIT] 백업 동기화 엔진 시작 (Mode: ${MODE})`);
    const now = DateTime.now().setZone('Asia/Seoul');

    let queryStart, queryEnd;
    if (MODE === 'range' && MANUAL_START && MANUAL_END) {
        queryStart = MANUAL_START; queryEnd = MANUAL_END;
    } else {
        queryStart = now.minus({ weeks: 3 }).toISODate();
        queryEnd = now.plus({ weeks: 2 }).toISODate();
    }
    addLog(`🗓️ 검색 범위: ${queryStart} ~ ${queryEnd}`);

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 30000, notionVersion: '2022-06-28' });

    addLog(`🔍 DB 하이브리드 탐색 중...`);
    // 뼈대 DB ID 매칭
    const DAILY_DB_ID = await getOrSearchDbId(notion, process.env.DAILY_DB_ID, 'Daily Archive');
    const WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.WEEKLY_DB_ID, 'Weekly Archive');
    const MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.MONTHLY_DB_ID, 'Monthly Archive');
    const FIN_WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.FIN_WEEKLY_DB_ID, 'Finance Weekly Archive');
    const FIN_MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.FIN_MONTHLY_DB_ID, 'Finance Monthly Archive');

    // 마스터 DB ID 매칭
    const PERSONAL_DB_ID = await getOrSearchDbId(notion, process.env.PERSONAL_MASTER_DB_ID, 'Personal Master');
    const FINANCE_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_MASTER_DB_ID, 'Finance Master');
    const MEDIA_DB_ID = await getOrSearchDbId(notion, process.env.MEDIA_MASTER_DB_ID, 'Media Master');

    let allTargetDbs = [];
    if (PERSONAL_DB_ID) allTargetDbs.push({ id: PERSONAL_DB_ID, name: "Personal", key: "personal" });
    if (FINANCE_DB_ID) allTargetDbs.push({ id: FINANCE_DB_ID, name: "Finance", key: "finance" });
    if (MEDIA_DB_ID) allTargetDbs.push({ id: MEDIA_DB_ID, name: "Media", key: "media" });

    if (TARGET_DBS !== 'all') {
        const allowed = TARGET_DBS.split(',').map(s => s.trim());
        allTargetDbs = allTargetDbs.filter(db => allowed.includes(db.key));
    }

    if (allTargetDbs.length === 0) {
        addLog(`⏭️ 동기화할 마스터 DB가 검색되지 않았습니다. 작업을 스킵합니다.`);
        return;
    }

    const tasksToSync = [];
    let minRefDate = queryStart;
    let maxRefDate = queryEnd;
    const searchStart = DateTime.fromISO(queryStart).minus({ days: 7 }).toISODate();

    for (const db of allTargetDbs) {
        addLog(`\n📂 [${db.name} Master] 일정 스캔 시작...`);
        let items = [];
        let hasMore = true; let cursor = undefined;
        
        while (hasMore) {
            try {
                const res = await notion.databases.query({
                    database_id: db.id, 
                    filter: {
                        and: [
                            { property: "Schedule", date: { on_or_after: searchStart } },
                            { property: "Schedule", date: { on_or_before: queryEnd } }
                        ]
                    },
                    sorts: [{ property: "Schedule", direction: "descending" }],
                    page_size: 100, start_cursor: cursor
                });
                items = [...items, ...res.results];
                hasMore = res.has_more; cursor = res.next_cursor;
                await delay(200);
            } catch (e) {
                addLog(`  ⚠️ DB 조회 에러 (${db.name}): ${e.message}`);
                hasMore = false;
            }
        }

        items = items.filter(item => {
            const taskRange = calculateTaskRange(item, db.name);
            if (!taskRange) return false;
            if (taskRange.start <= queryEnd && taskRange.end >= queryStart) {
                if (taskRange.start < minRefDate) minRefDate = taskRange.start;
                if (taskRange.end > maxRefDate) maxRefDate = taskRange.end;
                return true;
            }
            return false;
        });

        addLog(`  📊 ${items.length}개 항목 발견`);
        if (items.length > 0) tasksToSync.push({ db, items });
    }

    if (tasksToSync.length > 0) {
        addLog(`\n📥 아카이브 DB(뼈대) 로딩 중...`);
        const refStart = DateTime.fromISO(minRefDate).minus({ days: 7 }).toISODate();
        const refEnd = DateTime.fromISO(maxRefDate).plus({ days: 7 }).toISODate();
        
        const refFilter = {
            and: [
                { property: "Schedule", date: { on_or_after: refStart } },
                { property: "Schedule", date: { on_or_before: refEnd } }
            ]
        };

        const loadRefDB = async (dbId, name) => {
            if (!dbId) return [];
            let allResults = []; let hasMore = true; let cursor = undefined;
            while (hasMore) {
                try {
                    const res = await notion.databases.query({
                        database_id: dbId, filter: refFilter, page_size: 100, start_cursor: cursor
                    });
                    allResults = [...allResults, ...res.results];
                    hasMore = res.has_more; cursor = res.next_cursor;
                    await delay(150);
                } catch (e) { hasMore = false; }
            }
            return allResults;
        };

        const hasFin = tasksToSync.some(g => g.db.name === "Finance");
        const hasNonFin = tasksToSync.some(g => g.db.name !== "Finance");

        const [dailyRaw, weekly, monthly, finWeekly, finMonthly] = await Promise.all([
            DAILY_DB_ID ? loadRefDB(DAILY_DB_ID, "Daily") : Promise.resolve([]),
            hasNonFin && WEEKLY_DB_ID ? loadRefDB(WEEKLY_DB_ID, "Weekly") : Promise.resolve([]),
            hasNonFin && MONTHLY_DB_ID ? loadRefDB(MONTHLY_DB_ID, "Monthly") : Promise.resolve([]),
            hasFin && FIN_WEEKLY_DB_ID ? loadRefDB(FIN_WEEKLY_DB_ID, "FinWeekly") : Promise.resolve([]),
            hasFin && FIN_MONTHLY_DB_ID ? loadRefDB(FIN_MONTHLY_DB_ID, "FinMonthly") : Promise.resolve([])
        ]);

        const dailyMap = new Map(); 
        dailyRaw.forEach(page => {
            const d = getSafeDateRange(page.properties.Schedule);
            if (d && d.start) dailyMap.set(d.start, page.id);
        });

        const refMap = { weekly, monthly, finWeekly, finMonthly };
        const findDailyIdInMemory = (dateStr) => dailyMap.get(dateStr) || null;

        const findOverlappingIds = (taskStart, taskEnd, dbType) => {
            const candidates = refMap[dbType] || [];
            const matchedIds = [];
            for (const p of candidates) {
                const d = getSafeDateRange(p.properties.Schedule);
                if (!d) continue;
                let pStart = d.start; let pEnd = d.end;
                if (pStart === pEnd) {
                    if (dbType.includes('weekly')) pEnd = DateTime.fromISO(pStart).plus({ days: 6 }).toISODate();
                    else if (dbType.includes('monthly')) pEnd = DateTime.fromISO(pStart).endOf('month').toISODate();
                }
                if (taskStart <= pEnd && taskEnd >= pStart) matchedIds.push(p.id);
            }
            return matchedIds;
        };

        for (const group of tasksToSync) {
            const db = group.db;
            addLog(`\n🔄 [${db.name} Master] 동기화 처리 시작...`);
            
            for (let i = 0; i < group.items.length; i += 3) {
                const batch = group.items.slice(i, i + 3);
                await Promise.all(batch.map(async (item) => {
                    const title = getPageTitle(item);
                    const taskRange = calculateTaskRange(item, db.name);
                    const updatePayload = {};

                    const linkCore = (propName, dbType, isDaily = false) => {
                        const prop = item.properties[propName];
                        if (!prop || prop.type !== 'relation') return;

                        let requiredIds = [];
                        if (isDaily) {
                            const days = getDaysArray(taskRange.start, taskRange.end);
                            requiredIds = days.map(day => findDailyIdInMemory(day)).filter(id => id !== null);
                        } else {
                            requiredIds = findOverlappingIds(taskRange.start, taskRange.end, dbType);
                        }

                        const currentIds = new Set((prop.relation || []).map(r => r.id));
                        const isSame = requiredIds.length === currentIds.size && requiredIds.every(id => currentIds.has(id));

                        if (!isSame) updatePayload[propName] = { relation: requiredIds.map(id => ({ id })) };
                    };

                    // ✨ 지정하신 속성명에 맞춘 매칭 로직
                    if (db.name === "Personal" || db.name === "Media") {
                        linkCore("Backup", "daily", true);
                        linkCore("Week Check", "weekly");
                        linkCore("Month Check", "monthly");
                        
                        // Self Backup (자체 연결)
                        const selfProp = item.properties["Self Backup"];
                        if (selfProp && selfProp.type === 'relation') {
                            const currentSelf = (selfProp.relation || []).map(r => r.id);
                            if (!currentSelf.includes(item.id)) {
                                updatePayload["Self Backup"] = { relation: [{ id: item.id }] };
                            }
                        }
                    } else if (db.name === "Finance") {
                        linkCore("Backup", "daily", true);
                        linkCore("Week Backup", "weekly");
                        linkCore("Week Check", "finWeekly");
                        linkCore("Month Backup", "monthly");
                        linkCore("Month Check", "finMonthly");
                    }

                    if (Object.keys(updatePayload).length > 0) {
                        try {
                            await notion.pages.update({ page_id: item.id, properties: updatePayload });
                            addLog(`  ✨ [SYNCED] ${title}`);
                        } catch (e) { addLog(`  ❌ [FAILED] ${title}: ${e.message}`); }
                    }
                }));
                await delay(150);
            }
        }
    }
    addLog(`\n🏁 모든 백업 연결 작업이 완료되었습니다!`);
}

module.exports = async (req, res) => {
    const { key } = req.query;
    if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
        return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
    }
    try { 
        await executeSync(req.query || {}); 
        res.status(200).json({ success: true, logs: frontendLogs }); 
    }
    catch (err) { 
        res.status(500).json({ error: err.message, logs: frontendLogs }); 
    }
};