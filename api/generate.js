const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');

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

// ✨ [하이브리드 탐색] DB ID가 없으면 '2027_Store' 등의 패턴을 무시하고 핵심 키워드로 DB를 자동 검색
async function getOrSearchDbId(notion, envId, keyword) {
    if (envId && envId.trim().length > 0) return envId.trim();
    try {
        const res = await notion.search({ filter: { property: 'object', value: 'database' }, page_size: 100 });
        const matched = res.results.find(db => {
            const titleArr = db.title || [];
            const rawTitle = titleArr.map(t => t.plain_text).join('');
            const cleanTitle = rawTitle.replace(/20\d\d_Store/gi, '').trim().toLowerCase();
            return cleanTitle.includes(keyword.toLowerCase());
        });
        return matched ? matched.id : null;
    } catch (e) {
        return null;
    }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { key, type, year, month, part, target } = req.query; 
  if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
      return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if(!NOTION_TOKEN) return res.status(500).json({ success: false, error: "Token missing" });

  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 60000, notionVersion: '2022-06-28' });
  const targetYear = parseInt(year);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  try {
    // 🔍 하이브리드 DB 검색 실행 (고객이 빈칸으로 둔 템플릿은 null로 할당되어 스킵됨)
    const ANNUAL_DB_ID = await getOrSearchDbId(notion, process.env.ANNUAL_DB_ID, 'Annual Archive');
    const MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.MONTHLY_DB_ID, 'Monthly Archive');
    const WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.WEEKLY_DB_ID, 'Weekly Archive');
    const DAILY_DB_ID = await getOrSearchDbId(notion, process.env.DAILY_DB_ID, 'Daily Archive');
    const FINANCE_MONTHLY_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_MONTHLY_DB_ID, 'Finance Monthly Archive');
    const FINANCE_WEEKLY_DB_ID = await getOrSearchDbId(notion, process.env.FINANCE_WEEKLY_DB_ID, 'Finance Weekly Archive');

    const created = []; const skipped = [];
    
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

    // ==========================================
    // STEP 1. 페이지 자동 생성 (Generator)
    // ==========================================
    if (type === 'year_month') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exAnn = await getExistingTitles(ANNUAL_DB_ID, yStart, yEnd);
        const exMon = await getExistingTitles(MONTHLY_DB_ID, yStart, yEnd);
        const exFinMon = await getExistingTitles(FINANCE_MONTHLY_DB_ID, yStart, yEnd);

        const createFast = async (dbId, title, start, end, existingSet, iconUrl) => {
            if (!dbId) return; // 해당 DB가 없으면 스킵
            const startYear = start.substring(0, 4);
            if (existingSet.has(`${title}_${startYear}`)) { skipped.push(title); return; }
            const pageData = { parent: { database_id: dbId }, properties: { "Title": { title: [{ text: { content: title } }] }, "Schedule": { date: { start: start, end: end || null } } } };
            if (iconUrl) pageData.icon = { type: 'external', external: { url: iconUrl } };
            await notion.pages.create(pageData);
            created.push(title);
        };

        await createFast(ANNUAL_DB_ID, `${targetYear}년`, `${targetYear}-01-01`, `${targetYear}-12-31`, exAnn, ICON_YEAR_MONTH);
        for (let m = 1; m <= 12; m++) {
            const dt = DateTime.local(targetYear, m, 1);
            const mTitle = dt.toFormat('MM월'); 
            await createFast(MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exMon, ICON_YEAR_MONTH);
            await createFast(FINANCE_MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exFinMon, ICON_YEAR_MONTH);
        }
    }

    if (type === 'weeks') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exWeek = await getExistingTitles(WEEKLY_DB_ID, yStart, yEnd);
        const exFinWeek = await getExistingTitles(FINANCE_WEEKLY_DB_ID, yStart, yEnd);

        const totalWeeks = DateTime.local(targetYear, 12, 28).weekNumber; 
        for (let w = 1; w <= totalWeeks; w++) {
            const dt = DateTime.fromObject({ weekYear: targetYear, weekNumber: w, weekday: 1 });
            if (month && parseInt(month) > 0 && dt.month !== parseInt(month)) continue;
            
            const wTitle = `${dt.toFormat('yy')}. ${dt.toFormat('MM')}. - w${w}`;
            const startIso = dt.toISODate(); const endIso = dt.plus({ days: 6 }).toISODate();
            const sYear = startIso.substring(0, 4);

            if (!exWeek.has(`${wTitle}_${sYear}`) && WEEKLY_DB_ID) {
                await notion.pages.create({ parent: { database_id: WEEKLY_DB_ID }, properties: { "Title": { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
                created.push(wTitle);
            } else { skipped.push(wTitle); }

            if (!exFinWeek.has(`${wTitle}_${sYear}`) && FINANCE_WEEKLY_DB_ID) {
                await notion.pages.create({ parent: { database_id: FINANCE_WEEKLY_DB_ID }, properties: { "Title": { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
            }
        }
    }

    if (type === 'daily') {
        const m = parseInt(month);
        const dt = DateTime.local(targetYear, m, 1);
        const existingDaily = await getExistingTitles(DAILY_DB_ID, dt.startOf('month').toISODate(), dt.endOf('month').toISODate());

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
                    properties: { "Title": { title: [{ text: { content: dTitle } }] }, "Schedule": { date: { start: day.toISODate(), end: null } } },
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

    // ==========================================
    // STEP 2. 뼈대 계층 자동 연결 (Linker)
    // ==========================================
    if (type === 'link') {
        const traceLogs = []; 
        const getPages = async (dbId, fStart, fEnd) => {
            if (!dbId) return [];
            let all = []; let cursor = undefined;
            do {
                const res = await notion.databases.query({
                    database_id: dbId,
                    filter: { and: [ { property: "Schedule", date: { on_or_after: fStart } }, { property: "Schedule", date: { on_or_before: fEnd } } ] },
                    sorts: [{ property: "Schedule", direction: "ascending" }], 
                    start_cursor: cursor
                });
                all = [...all, ...res.results];
                cursor = res.next_cursor;
            } while(cursor);
            return all.map(p => ({ id: p.id, title: extractTitle(p.properties), start: p.properties["Schedule"]?.date?.start }));
        };

        const getYearId = async () => {
            if (!ANNUAL_DB_ID) return null;
            try {
                let hasMore = true; let cursor = undefined;
                while(hasMore) {
                    const res = await notion.databases.query({ database_id: ANNUAL_DB_ID, start_cursor: cursor });
                    const p = res.results.find(x => extractTitle(x.properties).includes(targetYear.toString()));
                    if (p) return p.id;
                    hasMore = res.has_more; cursor = res.next_cursor;
                }
                return null;
            } catch(e) { return null; }
        };

        const findByTitle = (arr, title) => arr.find(a => a.title === title)?.id;
        const updates = [];
        
        const yearId = await getYearId();
        if (yearId) traceLogs.push(`🔍 Annual DB 정상 인식 완료`);
        else if (ANNUAL_DB_ID) traceLogs.push(`⚠️ Annual DB에서 ${targetYear}년 페이지 인식 실패`);

        if (target === 'year_month') {
            const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
            const [months, finMonths] = await Promise.all([
                getPages(MONTHLY_DB_ID, yStart, yEnd), getPages(FINANCE_MONTHLY_DB_ID, yStart, yEnd)
            ]);

            const processMonth = (arr) => {
                arr.forEach((m, i) => {
                    if (!m.start || !m.start.startsWith(targetYear.toString())) return;
                    const props = {
                        "Month Check": [{id: m.id}],
                        "Last Month": arr[i-1] ? [{id: arr[i-1].id}] : [], 
                        "Next Month": arr[i+1] ? [{id: arr[i+1].id}] : []
                    };
                    if (yearId) props["Year"] = [{id: yearId}];
                    updates.push({ id: m.id, props });
                });
            };
            processMonth(months); processMonth(finMonths);
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

            const processWeek = (arr, isFin) => {
                arr.forEach((w, i) => {
                    const mTitle = `${w.title.split('.')[1].trim()}월`; 
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
                    updates.push({ id: w.id, props });
                });
            };
            processWeek(weeks, false); processWeek(finWeeks, true);
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
                updates.push({ id: d.id, props });
            });
        }

        let successCount = 0; let errorMessages = [];
        for (let i = 0; i < updates.length; i += 5) {
            const batch = updates.slice(i, i + 5);
            await Promise.all(batch.map(async u => {
                const finalProps = {};
                for (const key in u.props) finalProps[key] = { relation: u.props[key] };
                try {
                    await notion.pages.update({ page_id: u.id, properties: finalProps });
                    successCount++;
                } catch (err) {
                    errorMessages.push(`ID 에러: ${err.message}`);
                }
            }));
        }
        
        if (errorMessages.length > 0) return res.status(200).json({ success: false, error: `일부 실패: ${errorMessages[0]}` });
        
        traceLogs.push(`✨ ${successCount}개 연결 성공!`);
        return res.status(200).json({ success: true, message: `${successCount}개 연결 성공!`, logs: traceLogs });
    }

    res.status(200).json({ success: true, message: `생성: ${created.length} / 스킵: ${skipped.length}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};