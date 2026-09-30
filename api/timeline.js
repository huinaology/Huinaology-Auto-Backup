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

// 기존 Public 라벨 형식(디자인) 그대로 유지: "MM-DD HH:00" (아이콘/색상 없음)
function hourLabel(dateISO, hour) {
    return `${dateISO.substring(5)} ${String(hour).padStart(2, '0')}:00`;
}

// 정시~정시+1시간(정확히 60분)짜리 KST 구간을 만든다.
//   ※ 예전 방식(정시~:59분)은 각 시간 사이에 1분씩 빈틈이 생겨 합계 계산이 어긋나므로 폐기.
function hourSlotRange(dateISO, hour) {
    const start = DateTime.fromISO(dateISO, { zone: 'Asia/Seoul' }).plus({ hours: hour });
    const end = start.plus({ hours: 1 });
    return { start: start.toISO({ suppressMilliseconds: true }), end: end.toISO({ suppressMilliseconds: true }) };
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
//  - 없는 시간대는 새로 만든다.
//  - 이미 있는데 Schedule이 정확한 정시~정시+1시간이 아니거나 Backup 연결이
//    빠져있으면 그 부분만 고친다 (자동 생성분에 한해서만).
//  - "자동 생성분"인지 판별하는 기준은 제목이 hourLabel() 형식과 정확히
//    일치하는지 여부뿐이다. 사용자가 편의상 만든 페이지(예: "11:30-12:00"
//    같은 커스텀 제목)는 이 형식과 다르므로 절대 건드리지 않는다.
// =====================================================================
async function scanAndFixDay(notion, timelineDbId, dailyDbId, dateISO, schedPropName, titlePropName, backupPropName) {
    const dayStart = dateISO;
    const dayEnd = DateTime.fromISO(dateISO, { zone: 'Asia/Seoul' }).plus({ days: 1 }).toISODate();

    let existingPages = [];
    let hasMore = true, cursor = undefined;
    while (hasMore) {
        const res = await notion.databases.query({
            database_id: timelineDbId,
            filter: { and: [
                { property: schedPropName, date: { on_or_after: dayStart } },
                { property: schedPropName, date: { on_or_before: dayEnd } }
            ] },
            start_cursor: cursor, page_size: 100
        });
        existingPages = existingPages.concat(res.results);
        hasMore = res.has_more; cursor = res.next_cursor;
        await delay(120);
    }

    // 제목이 우리 표준 라벨과 정확히 일치하는 페이지만 "자동 생성분"으로 인식
    const byHour = new Map();
    existingPages.forEach(p => {
        const titleArr = p.properties[titlePropName]?.title || [];
        const titleText = titleArr.map(t => t.plain_text).join('');
        for (let h = 0; h < 24; h++) {
            if (titleText === hourLabel(dateISO, h)) { byHour.set(h, p); break; }
        }
    });

    const dailyPageId = await findDailyPageId(notion, dailyDbId, dateISO, schedPropName);

    let created = 0, fixed = 0, skipped = 0;
    for (let h = 0; h < 24; h++) {
        const { start, end } = hourSlotRange(dateISO, h);
        const page = byHour.get(h);

        if (!page) {
            const properties = {
                [titlePropName]: { title: [{ text: { content: hourLabel(dateISO, h) } }] },
                [schedPropName]: { date: { start, end } }
            };
            if (dailyPageId && backupPropName) properties[backupPropName] = { relation: [{ id: dailyPageId }] };
            try {
                await notion.pages.create({ parent: { database_id: timelineDbId }, properties });
                created++;
            } catch (e) {
                addLog(`  ❌ [${hourLabel(dateISO, h)}] 생성 실패: ${e.message}`);
            }
        } else {
            const sched = page.properties[schedPropName]?.date;
            const isExactTime = !!(sched && sched.start && sched.end
                && DateTime.fromISO(sched.start).toMillis() === DateTime.fromISO(start).toMillis()
                && DateTime.fromISO(sched.end).toMillis() === DateTime.fromISO(end).toMillis());
            const currentBackupIds = backupPropName ? (page.properties[backupPropName]?.relation || []).map(r => r.id) : [];
            const needsBackupFix = !!(dailyPageId && backupPropName && !currentBackupIds.includes(dailyPageId));

            if (!isExactTime || needsBackupFix) {
                const updateProps = {};
                if (!isExactTime) updateProps[schedPropName] = { date: { start, end } };
                if (needsBackupFix) updateProps[backupPropName] = { relation: [{ id: dailyPageId }] };
                try {
                    await notion.pages.update({ page_id: page.id, properties: updateProps });
                    fixed++;
                } catch (e) {
                    addLog(`  ❌ [${hourLabel(dateISO, h)}] 수정 실패: ${e.message}`);
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
