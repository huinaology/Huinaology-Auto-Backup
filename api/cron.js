const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');

let frontendLogs = [];
function addLog(msg) { console.log(msg); frontendLogs.push(msg); }
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    const finalUpdateProp = props["Final Update"] || Object.values(props).find(p => p.id === 'Final Update');
    const finalUpdateDate = finalUpdateProp?.date?.start ? finalUpdateProp.date.start.substring(0, 10) : null;

    let iprRange = null;
    if (dbName === "Personal" || dbName === "Media") {
        const iprProp = props["⏲️ipr Calendar"] || props["ipr Calendar"];
        iprRange = getSafeDateRange(iprProp);
    }

    const schedKey = Object.keys(props).find(k => k.toLowerCase() === 'schedule');
    const schedProp = schedKey ? props[schedKey] : null;
    const schedRange = getSafeDateRange(schedProp);

    if (!schedRange && !iprRange) return null;

    let start = null;
    let end = null;

    // ✨ Range 합산 로직 방어코드 강화
    if (schedRange && iprRange) {
        start = (iprRange.start < schedRange.start) ? iprRange.start : schedRange.start;
        end = (iprRange.end > schedRange.end) ? iprRange.end : schedRange.end;
    } else if (schedRange) {
        start = schedRange.start;
        end = schedRange.end;
    } else if (iprRange) {
        start = iprRange.start;
        end = iprRange.end;
    }

    if (finalUpdateDate) end = finalUpdateDate;
    if (start > end) end = start;
    return { start, end };
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

async function executeSync(params) {
    frontendLogs = [];
    const now = DateTime.now().setZone('Asia/Seoul');
    const todayStr = now.toISODate();
    const mode = params.mode || 'today';
    const slot = params.slot; 

    addLog(`🟢 [INIT] 백업 동기화 시작 (Mode: ${mode}, Slot: ${slot || 'manual'})`);

    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 30000, notionVersion: '2022-06-28' });

    const TIMELINE_DB_ID = await getOrSearchDbId(notion, process.env.TIMELINE_DB_ID, 'Time Table');
    const DAILY_DB_ID = await getOrSearchDbId(notion, process.env.DAILY_DB_ID, 'Daily Archive');

    if (slot === 'morning' && TIMELINE_DB_ID) {
        addLog(`🌅 [Morning Auto] 오늘(${todayStr}) 24시간 타임라인 생성 체크 중...`);
        try {
            const existingQuery = await notion.databases.query({
                database_id: TIMELINE_DB_ID,
                filter: { property: "Schedule", date: { equals: todayStr } },
                page_size: 100
            });

            // ✨ 단순 갯수 파악이 아닌, 각 시간별 존재 여부 정확히 체크하여 누락본만 생성
            const existingHours = new Set();
            existingQuery.results.forEach(p => {
                const titleProp = Object.values(p.properties).find(prop => prop.type === 'title');
                if (titleProp && titleProp.title[0]) {
                    const titleText = titleProp.title[0].plain_text;
                    const hourMatch = titleText.match(/\s(\d{2}):00/);
                    if (hourMatch) existingHours.add(parseInt(hourMatch[1]));
                }
            });

            let createdCount = 0;
            for (let h = 0; h < 24; h++) {
                if (!existingHours.has(h)) {
                    const hourStr = String(h).padStart(2, '0') + ":00";
                    await notion.pages.create({
                        parent: { database_id: TIMELINE_DB_ID },
                        properties: {
                            "Title": { title: [{ text: { content: `${todayStr.substring(5)} ${hourStr}` } }] },
                            "Schedule": { date: { start: todayStr } }
                        }
                    });
                    createdCount++;
                }
            }
            if (createdCount > 0) addLog(`✅ ${createdCount}개의 누락된 타임라인 생성 완료`);
            else addLog(`ℹ️ 이미 오늘 날짜의 24시간 타임라인이 완벽히 존재하여 생성을 스킵합니다.`);
        } catch (e) {
            addLog(`⚠️ 타임라인 자동 생성 에러: ${e.message}`);
        }
    }

    let MANUAL_START = (params.start_date || '').replace(/[^0-9-]/g, '');
    let MANUAL_END = (params.end_date || '').replace(/[^0-9-]/g, '');
    let queryStart = (MANUAL_START && MANUAL_END) ? MANUAL_START : now.minus({ weeks: 3 }).toISODate();
    let queryEnd = (MANUAL_START && MANUAL_END) ? MANUAL_END : now.plus({ weeks: 2 }).toISODate();

    const WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.WEEKLY_DB_ID, 'Weekly Archive');
    const MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.MONTHLY_DB_ID, 'Monthly Archive');
    const FIN_WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.FIN_WEEKLY_DB_ID, 'Finance Weekly Archive');
    const FIN_MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.FIN_MONTHLY_DB_ID, 'Finance Monthly Archive');

    const PERSONAL_DB_ID = await getOrSearchDbId(notion, process.env.PERSONAL_MASTER_DB_ID, 'Personal Master');
    const FINANCE_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_MASTER_DB_ID, 'Finance Master');
    const MEDIA_DB_ID = await getOrSearchDbId(notion, process.env.MEDIA_MASTER_DB_ID, 'Media Master');

    let allTargetDbs = [];
    if (PERSONAL_DB_ID) allTargetDbs.push({ id: PERSONAL_DB_ID, name: "Personal", key: "personal" });
    if (FINANCE_DB_ID) allTargetDbs.push({ id: FINANCE_DB_ID, name: "Finance", key: "finance" });
    if (MEDIA_DB_ID) allTargetDbs.push({ id: MEDIA_DB_ID, name: "Media", key: "media" });
    if (TIMELINE_DB_ID) allTargetDbs.push({ id: TIMELINE_DB_ID, name: "Timeline", key: "timeline" });

    const TARGET_DBS = params.target_dbs || 'all';
    if (TARGET_DBS !== 'all') {
        const allowed = TARGET_DBS.split(',').map(s => s.trim());
        allTargetDbs = allTargetDbs.filter(db => allowed.includes(db.key));
    }

    const tasksToSync = [];
    let minRefDate = queryStart;
    let maxRefDate = queryEnd;
    const searchStart = DateTime.fromISO(queryStart).minus({ days: 7 }).toISODate();

    for (const db of allTargetDbs) {
        let items = []; let hasMore = true; let cursor = undefined;
        while (hasMore) {
            try {
                const res = await notion.databases.query({
                    database_id: db.id, 
                    filter: { property: "Schedule", date: { on_or_after: searchStart } },
                    page_size: 100, start_cursor: cursor
                });
                items = [...items, ...res.results];
                hasMore = res.has_more; cursor = res.next_cursor;
                await delay(150);
            } catch (e) { hasMore = false; }
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

        if (items.length > 0) tasksToSync.push({ db, items });
    }

    if (tasksToSync.length > 0) {
        const refStart = DateTime.fromISO(minRefDate).minus({ days: 7 }).toISODate();
        const refEnd = DateTime.fromISO(maxRefDate).plus({ days: 7 }).toISODate();
        const refFilter = { and: [{ property: "Schedule", date: { on_or_after: refStart } }, { property: "Schedule", date: { on_or_before: refEnd } }] };

        const loadRefDB = async (dbId) => {
            if (!dbId) return [];
            let all = []; let hasMore = true; let cursor = undefined;
            while (hasMore) {
                try {
                    const res = await notion.databases.query({ database_id: dbId, filter: refFilter, page_size: 100, start_cursor: cursor });
                    all = [...all, ...res.results]; hasMore = res.has_more; cursor = res.next_cursor;
                    await delay(150);
                } catch (e) { hasMore = false; }
            }
            return all;
        };

        const hasFin = tasksToSync.some(g => g.db.name === "Finance");
        const hasNonFin = tasksToSync.some(g => g.db.name !== "Finance");

        const [dailyRaw, weekly, monthly, finWeekly, finMonthly] = await Promise.all([
            DAILY_DB_ID ? loadRefDB(DAILY_DB_ID) : Promise.resolve([]),
            hasNonFin && WEEKLY_DB_ID ? loadRefDB(WEEKLY_DB_ID) : Promise.resolve([]),
            hasNonFin && MONTHLY_DB_ID ? loadRefDB(MONTHLY_DB_ID) : Promise.resolve([]),
            hasFin && FIN_WEEKLY_DB_ID ? loadRefDB(FIN_WEEKLY_DB_ID) : Promise.resolve([]),
            hasFin && FIN_MONTHLY_DB_ID ? loadRefDB(FIN_MONTHLY_DB_ID) : Promise.resolve([])
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
            for (let i = 0; i < group.items.length; i += 3) {
                const batch = group.items.slice(i, i + 3);
                await Promise.all(batch.map(async (item) => {
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

                    if (db.name === "Personal" || db.name === "Media") {
                        linkCore("Backup", "daily", true);
                        linkCore("Week Check", "weekly");
                        linkCore("Month Check", "monthly");
                        
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
                    } else if (db.name === "Timeline") {
                        linkCore("Backup", "daily", true);
                    }

                    if (Object.keys(updatePayload).length > 0) {
                        try {
                            await notion.pages.update({ page_id: item.id, properties: updatePayload });
                        } catch (e) {}
                    }
                }));
                await delay(150);
            }
        }
    }
    addLog(`🏁 동기화 완료`);
}

module.exports = async (req, res) => {
    const { key } = req.query;
    // ✨ Vercel Cron 요청일 경우 비밀번호 무시하고 패스 (헤더 체크)
    const isCron = req.headers['user-agent'] === 'vercel-cron/1.0';
    
    if (!isCron && (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET)) {
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