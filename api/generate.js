const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ICON_YEAR_MONTH = 'https://api.iconify.design/lucide/calendar.svg?color=black';
const ICON_WEEK = 'https://api.iconify.design/lucide/calendar-range.svg?color=black';

const getDailyIcon = (weekdayStr) => {
    if (weekdayStr === '토') return 'https://api.iconify.design/lucide/calendar-days.svg?color=%233b82f6'; 
    if (weekdayStr === '일') return 'https://api.iconify.design/lucide/calendar-days.svg?color=%23ef4444'; 
    return 'https://api.iconify.design/lucide/calendar-days.svg?color=black'; 
};

const extractTitle = (properties) => {
    if (!properties) return '';
    const key = Object.keys(properties).find(k => properties[k].type === 'title');
    if (!key || !properties[key].title || properties[key].title.length === 0) return '';
    return properties[key].title.map(t => t.plain_text).join('');
};

async function getOrSearchDbId(notion, envId, keyword) {
    if (envId && envId.trim().length > 0) return envId.trim();
    try {
        const res = await notion.search({ filter: { property: 'object', value: 'database' }, page_size: 100 });
        const matched = res.results.find(db => {
            const rawTitle = (db.title || []).map(t => t.plain_text).join('');
            const cleanTitle = rawTitle.replace(/20\d\d_Store/gi, '').trim().toLowerCase();
            return cleanTitle.includes(keyword.toLowerCase());
        });
        return matched ? matched.id : null;
    } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { key, type, year, month, target } = req.query; 
  if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
      return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if(!NOTION_TOKEN) return res.status(500).json({ success: false, error: "Token missing" });

  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 60000, notionVersion: '2022-06-28' });
  const targetYear = parseInt(year);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  try {
    const ANNUAL_DB_ID = await getOrSearchDbId(notion, process.env.ANNUAL_DB_ID, 'Annual Archive');
    const MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.MONTHLY_DB_ID, 'Monthly Archive');
    const WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.WEEKLY_DB_ID, 'Weekly Archive');
    const DAILY_DB_ID = await getOrSearchDbId(notion, process.env.DAILY_DB_ID, 'Daily Archive');
    const FINANCE_MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_MONTHLY_DB_ID, 'Finance Monthly Archive');
    const FINANCE_WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_WEEKLY_DB_ID, 'Finance Weekly Archive');

    const created = []; const skipped = [];

    // 제목 속성 이름은 사용자가 "이름"/"Name" 등으로 바꿔뒀을 수 있으니,
    // "Title"로 고정하지 않고 DB마다 실제 title 타입 속성을 찾아서 사용한다.
    const titlePropCache = {};
    const getTitleProp = async (dbId) => {
        if (!dbId) return 'Title';
        if (titlePropCache[dbId]) return titlePropCache[dbId];
        try {
            const info = await notion.databases.retrieve({ database_id: dbId });
            const key = Object.keys(info.properties).find(k => info.properties[k].type === 'title') || 'Title';
            titlePropCache[dbId] = key;
            return key;
        } catch (e) { return 'Title'; }
    };

    const getExistingTitles = async (dbId, start, end) => {
        if (!dbId) return new Set();
        const titles = new Set();
        let hasMore = true; let cursor = undefined;
        while(hasMore) {
            const response = await notion.databases.query({
                database_id: dbId,
                filter: { and: [ { property: "Schedule", date: { on_or_after: start } }, { property: "Schedule", date: { on_or_before: end } } ] },
                start_cursor: cursor
            });
            response.results.forEach(p => {
                const t = extractTitle(p.properties);
                const sDate = p.properties["Schedule"]?.date?.start;
                if(t && sDate) titles.add(`${t}_${sDate.substring(0,4)}`);
            });
            hasMore = response.has_more; cursor = response.next_cursor;
        }
        return titles;
    };

    const createFast = async (dbId, title, start, end, existingSet, iconUrl) => {
        if (!dbId) return;
        const startYear = start.substring(0, 4);
        if (existingSet.has(`${title}_${startYear}`)) { skipped.push(title); return; }
        const titleProp = await getTitleProp(dbId);
        const pageData = { parent: { database_id: dbId }, properties: { [titleProp]: { title: [{ text: { content: title } }] }, "Schedule": { date: { start: start, end: end || null } } } };
        if (iconUrl) pageData.icon = { type: 'external', external: { url: iconUrl } };
        await notion.pages.create(pageData);
        created.push(title);
    };

    if (type === 'year_month') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exAnn = await getExistingTitles(ANNUAL_DB_ID, yStart, yEnd);
        const exMon = await getExistingTitles(MONTHLY_DB_ID, yStart, yEnd);
        const exFinMon = await getExistingTitles(FINANCE_MONTHLY_DB_ID, yStart, yEnd);

        if (!month) {
            await createFast(ANNUAL_DB_ID, `${targetYear}년`, `${targetYear}-01-01`, `${targetYear}-12-31`, exAnn, ICON_YEAR_MONTH);
            for (let m = 1; m <= 12; m++) {
                const dt = DateTime.local(targetYear, m, 1);
                const mTitle = dt.toFormat('MM월'); 
                await createFast(MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exMon, ICON_YEAR_MONTH);
                await createFast(FINANCE_MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exFinMon, ICON_YEAR_MONTH);
            }
        } else {
            const mNum = parseInt(month);
            const dt = DateTime.local(targetYear, mNum, 1);
            const mTitle = dt.toFormat('MM월');
            await createFast(MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exMon, ICON_YEAR_MONTH);
            await createFast(FINANCE_MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exFinMon, ICON_YEAR_MONTH);
        }
    }

    if (type === 'weeks') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exWeek = await getExistingTitles(WEEKLY_DB_ID, yStart, yEnd);
        const exFinWeek = await getExistingTitles(FINANCE_WEEKLY_DB_ID, yStart, yEnd);
        const weekTitleProp = await getTitleProp(WEEKLY_DB_ID);
        const finWeekTitleProp = await getTitleProp(FINANCE_WEEKLY_DB_ID);

        const totalWeeks = DateTime.local(targetYear, 12, 28).weekNumber; 
        for (let w = 1; w <= totalWeeks; w++) {
            const dt = DateTime.fromObject({ weekYear: targetYear, weekNumber: w, weekday: 1 });
            if (month && parseInt(month) > 0 && dt.month !== parseInt(month)) continue;
            
            const wTitle = `${dt.toFormat('yy')}. ${dt.toFormat('MM')}. - w${w}`;
            const startIso = dt.toISODate(); const endIso = dt.plus({ days: 6 }).toISODate();
            const sYear = startIso.substring(0, 4);

            if (!exWeek.has(`${wTitle}_${sYear}`) && WEEKLY_DB_ID) {
                await notion.pages.create({ parent: { database_id: WEEKLY_DB_ID }, properties: { [weekTitleProp]: { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
                created.push(wTitle);
            } else { skipped.push(wTitle); }

            if (!exFinWeek.has(`${wTitle}_${sYear}`) && FINANCE_WEEKLY_DB_ID) {
                await notion.pages.create({ parent: { database_id: FINANCE_WEEKLY_DB_ID }, properties: { [finWeekTitleProp]: { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
            }
        }
    }

    if (type === 'daily') {
        const m = parseInt(month);
        const dt = DateTime.local(targetYear, m, 1);
        const existingDaily = await getExistingTitles(DAILY_DB_ID, dt.startOf('month').toISODate(), dt.endOf('month').toISODate());
        const dailyTitleProp = await getTitleProp(DAILY_DB_ID);

        const tasks = [];
        for (let d = 1; d <= dt.daysInMonth; d++) {
            const day = DateTime.local(targetYear, m, d);
            const dayNameStr = dayNames[day.weekday % 7]; 
            const dTitle = `${day.toFormat('yyMMdd')} [${dayNameStr}]`;
            const sYear = day.toISODate().substring(0, 4);

            if (existingDaily.has(`${dTitle}_${sYear}`)) { skipped.push(dTitle); continue; }

            tasks.push(async () => {
                if(!DAILY_DB_ID) return;
                await notion.pages.create({
                    parent: { database_id: DAILY_DB_ID },
                    properties: { [dailyTitleProp]: { title: [{ text: { content: dTitle } }] }, "Schedule": { date: { start: day.toISODate(), end: null } } },
                    icon: { type: 'external', external: { url: getDailyIcon(dayNameStr) } }
                });
                created.push(dTitle);
            });
        }

        for (let i = 0; i < tasks.length; i += 3) {
            await Promise.all(tasks.slice(i, i + 3).map(fn => fn()));
            await new Promise(r => setTimeout(r, 200)); 
        }
    }

    if (type === 'link') {
        const traceLogs = []; 
        const getPages = async (dbId, fStart, fEnd) => {
            if (!dbId) return [];
            let all = []; let cursor = undefined;
            let hasMore = true;
            while (hasMore) {
                let attempt = 0, success = false, res;
                while (attempt < 3 && !success) {
                    try {
                        res = await notion.databases.query({
                            database_id: dbId,
                            filter: { and: [ { property: "Schedule", date: { on_or_after: fStart } }, { property: "Schedule", date: { on_or_before: fEnd } } ] },
                            sorts: [{ property: "Schedule", direction: "ascending" }],
                            start_cursor: cursor
                        });
                        success = true;
                    } catch (e) {
                        attempt++;
                        if (e.code === 'validation_error' || attempt >= 3) throw e;
                        await delay(800 * attempt);
                    }
                }
                all = [...all, ...res.results];
                cursor = res.next_cursor;
                hasMore = res.has_more;
            }
            return all.map(p => ({ id: p.id, title: extractTitle(p.properties), start: p.properties["Schedule"]?.date?.start }));
        };

        // ※ Year 연결이 안 될 때 원인을 알 수 있도록, 실패하면 조용히 null만
        //   반환하지 말고 traceLogs에 이유를 남긴다 (ANNUAL_DB_ID 없음 / 해당
        //   연도 페이지를 못 찾음 / 조회 자체가 실패함, 세 가지를 구분).
        //   Notion 조회는 일시적 오류(레이트리밋 등)에 대비해 재시도한다.
        const getYearId = async () => {
            if (!ANNUAL_DB_ID) {
                traceLogs.push(`⚠️ Year 연결 건너뜀: ANNUAL_DB_ID를 찾을 수 없습니다.`);
                return null;
            }
            const seenTitles = [];
            try {
                let hasMore = true; let cursor = undefined;
                while (hasMore) {
                    let attempt = 0, success = false, res;
                    while (attempt < 3 && !success) {
                        try {
                            res = await notion.databases.query({ database_id: ANNUAL_DB_ID, start_cursor: cursor });
                            success = true;
                        } catch (e) {
                            attempt++;
                            if (e.code === 'validation_error' || attempt >= 3) throw e;
                            await delay(800 * attempt);
                        }
                    }
                    for (const x of res.results) {
                        const t = extractTitle(x.properties);
                        seenTitles.push(t);
                        if (t.includes(targetYear.toString())) return x.id;
                    }
                    hasMore = res.has_more; cursor = res.next_cursor;
                }
                traceLogs.push(`⚠️ Year 연결 건너뜀: Annual DB에서 "${targetYear}"이 포함된 제목을 찾지 못했습니다. (확인된 제목: ${seenTitles.slice(0, 10).join(', ') || '없음'})`);
                return null;
            } catch (e) {
                traceLogs.push(`⚠️ Year 연결 건너뜀: Annual DB 조회 실패 (${e.message})`);
                return null;
            }
        };

        // 사용자가 Last Month/Next Month 같은 관계형 속성을 지웠거나 다른 이름으로
        // 바꿔둔 DB도 있을 수 있다. 그런 속성을 포함해서 업데이트를 보내면 노션이
        // 전체 요청을 통째로 거부해서(하나라도 없는 속성이 있으면 전부 실패) Month
        // Check/Year처럼 실제로 존재하는 속성까지 같이 실패해버린다. 그래서 DB별로
        // 실제 존재하는 속성 이름을 미리 확인해두고, 없는 속성은 조용히 빼고 보낸다.
        const dbPropCache = {};
        const getDbPropertyNames = async (dbId) => {
            if (!dbId) return new Set();
            if (dbPropCache[dbId]) return dbPropCache[dbId];
            try {
                const info = await notion.databases.retrieve({ database_id: dbId });
                const names = new Set(Object.keys(info.properties));
                dbPropCache[dbId] = names;
                return names;
            } catch (e) { return new Set(); }
        };
        const missingPropsSeen = new Set();

        const findByTitle = (arr, title) => arr.find(a => a.title === title)?.id;
        const updates = [];
        
        const yearId = await getYearId();
        if (yearId) traceLogs.push(`🔍 Annual DB 인식 완료`);

        if (target === 'year_month') {
            const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
            const [months, finMonths] = await Promise.all([
                getPages(MONTHLY_DB_ID, yStart, yEnd), getPages(FINANCE_MONTHLY_DB_ID, yStart, yEnd)
            ]);

            const processMonth = (arr, dbId) => {
                arr.forEach((m, i) => {
                    if (!m.start || !m.start.startsWith(targetYear.toString())) return;
                    const props = {
                        "Month Check": [{id: m.id}],
                        "Last Month": arr[i-1] ? [{id: arr[i-1].id}] : [],
                        "Next Month": arr[i+1] ? [{id: arr[i+1].id}] : []
                    };
                    if (yearId) props["Year"] = [{id: yearId}];
                    updates.push({ id: m.id, props, dbId });
                });
            };
            processMonth(months, MONTHLY_DB_ID); processMonth(finMonths, FINANCE_MONTHLY_DB_ID);
        }

        if (target === 'weeks') {
            let fetchStart = `${targetYear-1}-11-01`; let fetchEnd = `${targetYear+1}-02-28`;
            if (month) {
                const dt = DateTime.local(targetYear, parseInt(month), 1);
                fetchStart = dt.minus({months: 2}).toISODate(); fetchEnd = dt.plus({months: 2}).endOf('month').toISODate();
            }

            const [months, finMonths, weeks, finWeeks] = await Promise.all([
                getPages(MONTHLY_DB_ID, fetchStart, fetchEnd), getPages(FINANCE_MONTHLY_DB_ID, fetchStart, fetchEnd),
                getPages(WEEKLY_DB_ID, fetchStart, fetchEnd), getPages(FINANCE_WEEKLY_DB_ID, fetchStart, fetchEnd)
            ]);

            const processWeek = (arr, isFin, dbId) => {
                arr.forEach((w, i) => {
                    // 제목 문자열을 쪼개서 월을 알아내던 예전 방식은 제목이 예상과 다른
                    // 페이지(공백 제목, 수동 편집 등)를 만나면 예외를 던져 전체 요청을
                    // 실패시켰다. 항상 존재하는 Schedule 시작일에서 직접 월을 구한다.
                    if (!w.start) return;
                    const mTitle = `${DateTime.fromISO(w.start).toFormat('MM')}월`;
                    if (month) {
                        const mStr = month.toString().padStart(2, '0');
                        if (mTitle !== `${mStr}월`) return;
                    } else {
                        if (!w.start || !w.start.startsWith(targetYear.toString())) return;
                    }

                    const mId = isFin ? findByTitle(finMonths, mTitle) : findByTitle(months, mTitle);
                    
                    const props = {
                        "Week Check": [{id: w.id}],
                        "Last Week": arr[i-1] ? [{id: arr[i-1].id}] : [], 
                        "Next Week": arr[i+1] ? [{id: arr[i+1].id}] : []
                    };
                    if (yearId) props["Year"] = [{id: yearId}];
                    if (mId) props["Month Check"] = [{id: mId}];
                    updates.push({ id: w.id, props, dbId });
                });
            };
            processWeek(weeks, false, WEEKLY_DB_ID); processWeek(finWeeks, true, FINANCE_WEEKLY_DB_ID);
        }

        if (target === 'daily') {
            const mStr = month.toString().padStart(2, '0');
            const dailyStart = DateTime.local(targetYear, parseInt(month), 1).toISODate();
            const dailyEnd = DateTime.local(targetYear, parseInt(month), 1).endOf('month').toISODate();
            const weekBufferStart = DateTime.local(targetYear, parseInt(month), 1).minus({days: 14}).toISODate();
            const weekBufferEnd = DateTime.local(targetYear, parseInt(month), 1).endOf('month').plus({days: 14}).toISODate();

            const [months, weeks, days] = await Promise.all([
                getPages(MONTHLY_DB_ID, dailyStart, dailyEnd), getPages(WEEKLY_DB_ID, weekBufferStart, weekBufferEnd),
                getPages(DAILY_DB_ID, dailyStart, dailyEnd)
            ]);

            days.forEach(d => {
                if (!d.start || !d.start.startsWith(`${targetYear}-${mStr}`)) return;
                const mId = findByTitle(months, `${mStr}월`);
                const dt = DateTime.fromISO(d.start);
                const wObj = weeks.find(w => {
                    const wStart = DateTime.fromISO(w.start);
                    return dt >= wStart && dt <= wStart.plus({days: 6});
                });
                
                const props = { "Backup": [{id: d.id}] };
                if (yearId) props["Year"] = [{id: yearId}];
                if (mId) props["Month Check"] = [{id: mId}];
                if (wObj) props["Week Check"] = [{id: wObj.id}];
                updates.push({ id: d.id, props, dbId: DAILY_DB_ID });
            });
        }

        let successCount = 0; let errorMessages = [];
        for (let i = 0; i < updates.length; i += 5) {
            const batch = updates.slice(i, i + 5);
            await Promise.all(batch.map(async u => {
                const validNames = await getDbPropertyNames(u.dbId);
                const finalProps = {};
                for (const key in u.props) {
                    if (validNames.size > 0 && !validNames.has(key)) {
                        if (!missingPropsSeen.has(key)) {
                            missingPropsSeen.add(key);
                            traceLogs.push(`⚠️ "${key}" 속성이 없어서 이 연결은 건너뜁니다. (속성명이 다르거나 삭제된 것 같습니다)`);
                        }
                        continue;
                    }
                    finalProps[key] = { relation: u.props[key] };
                }
                if (Object.keys(finalProps).length === 0) { successCount++; return; }
                try {
                    await notion.pages.update({ page_id: u.id, properties: finalProps });
                    successCount++;
                } catch (err) { errorMessages.push(err.message); }
            }));
            await delay(120);
        }

        if (errorMessages.length > 0) {
            traceLogs.push(`⚠️ ${successCount}개 성공 / ${errorMessages.length}개 실패`);
            traceLogs.push(...errorMessages.slice(0, 5).map(m => `  - ${m}`));
            return res.status(200).json({ success: false, error: `${successCount}개 성공 / ${errorMessages.length}개 실패`, logs: traceLogs });
        }
        traceLogs.push(`✨ ${successCount}개 연결 성공!`);
        return res.status(200).json({ success: true, message: `${successCount}개 연결 성공!`, logs: traceLogs });
    }

    res.status(200).json({ success: true, message: `생성: ${created.length} / 스킵: ${skipped.length}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};