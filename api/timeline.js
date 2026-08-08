const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');

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

module.exports = async (req, res) => {
    const { key, mode } = req.query;
    if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
        return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
    }

    frontendLogs = [];
    addLog(`⏱️ [Timeline] 백업 동기화 시작`);

    try {
        const NOTION_TOKEN = process.env.NOTION_TOKEN;
        const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 30000, notionVersion: '2022-06-28' });

        const [timelineDbId, dailyDbId] = await Promise.all([
            getOrSearchDbId(notion, process.env.TIMELINE_DB_ID, 'Time Table'),
            getOrSearchDbId(notion, process.env.DAILY_DB_ID, 'Daily Archive')
        ]);

        if (!timelineDbId || !dailyDbId) {
            return res.status(200).json({ success: false, error: "Time Table 또는 Daily Archive DB를 찾을 수 없습니다.", logs: frontendLogs });
        }

        const now = DateTime.now().setZone('Asia/Seoul');
        const queryStart = now.minus({ days: 7 }).toISODate();
        const queryEnd = now.plus({ days: 7 }).toISODate();

        const [tRes, dRes] = await Promise.all([
            notion.databases.query({
                database_id: timelineDbId,
                filter: { property: "Schedule", date: { on_or_after: queryStart } }
            }),
            notion.databases.query({
                database_id: dailyDbId,
                filter: { and: [{ property: "Schedule", date: { on_or_after: queryStart } }, { property: "Schedule", date: { on_or_before: queryEnd } }] }
            })
        ]);

        const dailyMap = new Map();
        dRes.results.forEach(page => {
            const dateProp = page.properties.Schedule?.date?.start;
            if (dateProp) dailyMap.set(dateProp.substring(0, 10), page.id);
        });

        let count = 0;
        for (const item of tRes.results) {
            const dateProp = item.properties.Schedule?.date?.start;
            if (!dateProp) continue;
            const dateStr = dateProp.substring(0, 10);
            const dailyId = dailyMap.get(dateStr);

            if (dailyId) {
                const currentRel = (item.properties.Backup?.relation || []).map(r => r.id);
                if (!currentRel.includes(dailyId)) {
                    await notion.pages.update({
                        page_id: item.id,
                        properties: { "Backup": { relation: [{ id: dailyId }] } }
                    });
                    count++;
                }
            }
        }

        addLog(`✨ [Timeline] 타임라인 백업 완료 (${count}개 연결)`);
        res.status(200).json({ success: true, logs: frontendLogs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message, logs: frontendLogs });
    }
};