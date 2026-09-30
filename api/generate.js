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

    const created = []; const skipped = []; const adopted = [];

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

    // Annual/Monthly/Weekly/Daily 공통: 제목이 아니라 Schedule 날짜로 기존 페이지를
    // 찾는다. 사용자가 노션 템플릿 버튼으로 헤더 이미지를 미리 입혀서 만들어둔 빈
    // 페이지는 제목이 없어서 제목 기준으로는 "없는 날"로 오인되어 중복 생성될 수
    // 있다. 그런 페이지는 날짜만 맞으면 새로 만들지 않고 찾아서 제목만 채워 넣는다.
    const getExistingByDate = async (dbId, start, end) => {
        const map = new Map();
        if (!dbId) return map;
        let hasMore = true; let cursor = undefined;
        while (hasMore) {
            const response = await notion.databases.query({
                database_id: dbId,
                filter: { and: [ { property: "Schedule", date: { on_or_after: start } }, { property: "Schedule", date: { on_or_before: end } } ] },
                start_cursor: cursor
            });
            response.results.forEach(p => {
                const sDate = p.properties["Schedule"]?.date?.start;
                if (sDate) map.set(sDate.substring(0, 10), { id: p.id, title: extractTitle(p.properties) });
            });
            hasMore = response.has_more; cursor = response.next_cursor;
        }
        return map;
    };

    const createFast = async (dbId, title, start, end, existingByDate, iconUrl) => {
        if (!dbId) return;
        const existing = existingByDate.get(start);
        if (existing) {
            // 같은 날짜의 페이지가 이미 있음. 새로 만들지 않고, 제목이 비어있을 때만
            // 채운다. 커버/아이콘 등 기존 내용은 건드리지 않는다.
            if (!existing.title) {
                const titleProp = await getTitleProp(dbId);
                await notion.pages.update({ page_id: existing.id, properties: { [titleProp]: { title: [{ text: { content: title } }] } } });
                adopted.push(title);
            } else {
                skipped.push(title);
            }
            return;
        }
        const titleProp = await getTitleProp(dbId);
        const pageData = { parent: { database_id: dbId }, properties: { [titleProp]: { title: [{ text: { content: title } }] }, "Schedule": { date: { start: start, end: end || null } } } };
        if (iconUrl) pageData.icon = { type: 'external', external: { url: iconUrl } };
        await notion.pages.create(pageData);
        created.push(title);
    };

    if (type === 'year_month') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exAnn = await getExistingByDate(ANNUAL_DB_ID, yStart, yEnd);
        const exMon = await getExistingByDate(MONTHLY_DB_ID, yStart, yEnd);
        const exFinMon = await getExistingByDate(FINANCE_MONTHLY_DB_ID, yStart, yEnd);

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
        const exWeek = await getExistingByDate(WEEKLY_DB_ID, yStart, yEnd);
        const exFinWeek = await getExistingByDate(FINANCE_WEEKLY_DB_ID, yStart, yEnd);
        const weekTitleProp = await getTitleProp(WEEKLY_DB_ID);
        const finWeekTitleProp = await getTitleProp(FINANCE_WEEKLY_DB_ID);

        const totalWeeks = DateTime.local(targetYear, 12, 28).weekNumber;

        // ⚠️ 1년치(최대 52주 × 메인+재정 = 최대 104개) 페이지를 하나씩 순서대로
        // 생성하면 Vercel 함수 제한(60초)에 걸려 절반쯤에서 타임아웃난다.
        // Daily 생성과 동일하게 여러 개씩 묶어서 병렬로 생성한다.
        const weekTasks = [];
        for (let w = 1; w <= totalWeeks; w++) {
            const dt = DateTime.fromObject({ weekYear: targetYear, weekNumber: w, weekday: 1 });
            if (month && parseInt(month) > 0 && dt.month !== parseInt(month)) continue;

            const wTitle = `${dt.toFormat('yy')}. ${dt.toFormat('MM')}. - w${w}`;
            const startIso = dt.toISODate(); const endIso = dt.plus({ days: 6 }).toISODate();

            const existingMain = exWeek.get(startIso);
            if (existingMain) {
                // 같은 날짜의 페이지가 이미 있음. 제목이 비어있을 때만 채운다.
                if (!existingMain.title) {
                    weekTasks.push(async () => {
                        await notion.pages.update({ page_id: existingMain.id, properties: { [weekTitleProp]: { title: [{ text: { content: wTitle } }] } } });
                        adopted.push(wTitle);
                    });
                } else { skipped.push(wTitle); }
            } else if (WEEKLY_DB_ID) {
                weekTasks.push(async () => {
                    await notion.pages.create({ parent: { database_id: WEEKLY_DB_ID }, properties: { [weekTitleProp]: { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
                    created.push(wTitle);
                });
            }

            const existingFin = exFinWeek.get(startIso);
            if (existingFin) {
                if (!existingFin.title) {
                    weekTasks.push(async () => {
                        await notion.pages.update({ page_id: existingFin.id, properties: { [finWeekTitleProp]: { title: [{ text: { content: wTitle } }] } } });
                        adopted.push(wTitle);
                    });
                }
            } else if (FINANCE_WEEKLY_DB_ID) {
                weekTasks.push(async () => {
                    await notion.pages.create({ parent: { database_id: FINANCE_WEEKLY_DB_ID }, properties: { [finWeekTitleProp]: { title: [{ text: { content: wTitle } }] }, "Schedule": { date: { start: startIso, end: endIso } } }, icon: { type: 'external', external: { url: ICON_WEEK } } });
                });
            }
        }

        for (let i = 0; i < weekTasks.length; i += 4) {
            await Promise.all(weekTasks.slice(i, i + 4).map(fn => fn()));
            await delay(150);
        }
    }

    if (type === 'daily') {
        const m = parseInt(month);
        const dt = DateTime.local(targetYear, m, 1);
        const existingByDate = await getExistingByDate(DAILY_DB_ID, dt.startOf('month').toISODate(), dt.endOf('month').toISODate());
        const dailyTitleProp = await getTitleProp(DAILY_DB_ID);

        const tasks = [];
        for (let d = 1; d <= dt.daysInMonth; d++) {
            const day = DateTime.local(targetYear, m, d);
            const dayNameStr = dayNames[day.weekday % 7];
            const dTitle = `${day.toFormat('yyMMdd')} [${dayNameStr}]`;
            const dateKey = day.toISODate();
            const existing = existingByDate.get(dateKey);

            if (existing) {
                // 같은 날짜의 페이지가 이미 있음 (헤더 이미지 템플릿으로 미리 만들어둔
                // 빈 페이지일 수 있음). 중복 생성하지 않고, 제목이 비어있을 때만 채운다.
                // 커버/아이콘 등 기존에 넣어둔 내용은 절대 건드리지 않는다.
                if (!existing.title) {
                    tasks.push(async () => {
                        await notion.pages.update({
                            page_id: existing.id,
                            properties: { [dailyTitleProp]: { title: [{ text: { content: dTitle } }] } }
                        });
                        adopted.push(dTitle);
                    });
                } else {
                    skipped.push(dTitle);
                }
                continue;
            }

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
        // 월 제목("11월")은 연도를 담고 있지 않아서, 연도 앞뒤로 여유를 두고 조회하는
        // 범위 안에서는 같은 제목의 페이지가 여러 해에 걸쳐 여러 개 나올 수 있다.
        // (예: 2027년 기준 조회 범위엔 2026년 11월과 2027년 11월이 둘 다 들어있음)
        // 제목만 보고 첫 번째로 매칭되는 걸 집으면 오름차순 정렬 때문에 항상 더
        // 이른 연도(전년도) 페이지가 걸려서, 정작 원하는 연도엔 아무것도 안 붙는다.
        // 그래서 월/주 페이지처럼 제목에 연도가 없는 경우는 반드시 연도까지 같이 맞춰서 찾는다.
        const findByTitleAndYear = (arr, title, yearStr) => arr.find(a => a.title === title && a.start && a.start.startsWith(yearStr))?.id;
        const updates = [];
        
        const yearId = await getYearId();
        if (yearId) traceLogs.push(`🔍 Annual DB 인식 완료`);

        if (target === 'year_month') {
            const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
            const [months, finMonths] = await Promise.all([
                getPages(MONTHLY_DB_ID, yStart, yEnd), getPages(FINANCE_MONTHLY_DB_ID, yStart, yEnd)
            ]);

            const processMonth = (arr, dbId, isFin) => {
                arr.forEach((m, i) => {
                    if (!m.start || !m.start.startsWith(targetYear.toString())) return;
                    const props = {
                        "Month Check": [{id: m.id}],
                        "Last Month": arr[i-1] ? [{id: arr[i-1].id}] : [],
                        "Next Month": arr[i+1] ? [{id: arr[i+1].id}] : []
                    };
                    if (yearId) props["Year"] = [{id: yearId}];
                    // Finance Monthly는 같은 구간(제목+연도가 같은) Personal/메인 Monthly
                    // 페이지를 "Month Backup"에 연결한다.
                    if (isFin) {
                        const backupId = findByTitleAndYear(months, m.title, m.start.substring(0, 4));
                        if (backupId) props["Month Backup"] = [{id: backupId}];
                    }
                    updates.push({ id: m.id, props, dbId });
                });
            };
            processMonth(months, MONTHLY_DB_ID, false); processMonth(finMonths, FINANCE_MONTHLY_DB_ID, true);
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

                    const wYear = w.start.substring(0, 4);
                    const mId = isFin ? findByTitleAndYear(finMonths, mTitle, wYear) : findByTitleAndYear(months, mTitle, wYear);

                    const props = {
                        "Week Check": [{id: w.id}],
                        "Last Week": arr[i-1] ? [{id: arr[i-1].id}] : [], 
                        "Next Week": arr[i+1] ? [{id: arr[i+1].id}] : []
                    };
                    if (yearId) props["Year"] = [{id: yearId}];
                    if (mId) props["Month Check"] = [{id: mId}];
                    // Finance Weekly는 같은 구간(제목이 같은) 메인 Weekly/Monthly 페이지를
                    // 각각 "Week Backup"/"Month Backup"에 연결한다.
                    if (isFin) {
                        const weekBackupId = findByTitle(weeks, w.title);
                        if (weekBackupId) props["Week Backup"] = [{id: weekBackupId}];
                        const monthBackupId = findByTitleAndYear(months, mTitle, wYear);
                        if (monthBackupId) props["Month Backup"] = [{id: monthBackupId}];
                    }
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

    res.status(200).json({ success: true, message: `생성: ${created.length} / 빈 페이지 채움: ${adopted.length} / 스킵: ${skipped.length}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};