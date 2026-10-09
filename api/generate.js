const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');
const Config = require('../lib/config');
const Headers = require('../lib/headers');
const Tpl = require('../lib/template');

// 기존 페이지 커버 덮어쓰기는 사고 방지를 위해 이 날짜 이후 연도·페이지에만 허용한다.
const MIN_OVERWRITE_DATE = '2026-01-01';
const MIN_OVERWRITE_YEAR = 2026;
// 방금 수정된 페이지는 템플릿이 아직 적용 중일 수 있어(Daily는 최대 15초) 빈 페이지 판정을 건너뛴다.
const RECENT_EDIT_MS = 90 * 1000;
// Vercel 함수 제한(60초) 안에서 끝나도록 두는 시간 예산
const BUDGET_MS = 48 * 1000;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ICON_YEAR_MONTH = 'https://api.iconify.design/lucide/calendar.svg?color=black';
const ICON_WEEK = 'https://api.iconify.design/lucide/calendar-range.svg?color=black';

// 요일 아이콘은 기본 아이콘을 쓴다 (토=파랑, 일=빨강, 나머지=검정)
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
  const startedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { key, type, year, month, part, target, overwriteCover, overwriteTemplate, scope } = req.query;
  if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
      return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
  }
  const overwrite = overwriteCover === '1';
  const eraseTemplate = overwriteTemplate === '1';
  // Monthly/Weekly 처리 대상: scope=personal → Personal만 / finance → Finance만 / 그 외(기본) → 둘 다. (Annual·Daily는 Personal 쪽)
  const doPersonal = scope !== 'finance';
  const doFinance = scope !== 'personal';

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if(!NOTION_TOKEN) return res.status(500).json({ success: false, error: "Token missing" });

  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 60000, notionVersion: '2022-06-28' });
  const targetYear = parseInt(year);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  if (overwrite && ['year_month', 'weeks', 'daily'].includes(type) && !(targetYear >= MIN_OVERWRITE_YEAR)) {
      return res.status(400).json({ success: false, error: `커버 덮어쓰기는 ${MIN_OVERWRITE_YEAR}년 이후 연도만 가능합니다. (요청: ${year}년)` });
  }

  try {
    const ANNUAL_DB_ID = await getOrSearchDbId(notion, Config.ENV.ANNUAL_DB_ID, 'Annual Archive');
    const MONTHLY_DB_ID = await getOrSearchDbId(notion, Config.ENV.MONTHLY_DB_ID, 'Monthly Archive');
    const WEEKLY_DB_ID = await getOrSearchDbId(notion, Config.ENV.WEEKLY_DB_ID, 'Weekly Archive');
    const DAILY_DB_ID = await getOrSearchDbId(notion, Config.ENV.DAILY_DB_ID, 'Daily Archive');
    const FINANCE_MONTHLY_DB_ID = await getOrSearchDbId(notion, Config.ENV.FIN_MONTHLY_DB_ID, 'Finance Monthly Archive');
    const FINANCE_WEEKLY_DB_ID = await getOrSearchDbId(notion, Config.ENV.FIN_WEEKLY_DB_ID, 'Finance Weekly Archive');

    const created = []; const skipped = []; const adopted = []; const recovered = []; let covered = 0;
    // Auto_fill(DB 기본 템플릿) 적용 집계: 새 페이지에 적용 / 빈 기존 페이지에 적용 / 비우고 다시 적용 / 템플릿 없이 만든 수
    let templated = 0; let tplFallback = 0; let tplFallbackReason = ''; const filled = []; const reapplied = []; const tplWarnings = [];
    // 헤더(커버) 이미지는 이 프로젝트의 /headers 폴더에서 서빙된다. 맞는 이미지가 없으면 커버 없이 만든다.
    const assetBase = Headers.getAssetBase(req);

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

    // 새 페이지 생성 (+ 기본 템플릿). 템플릿이 거부되면 템플릿 없이 만들고 경고에 남긴다.
    const createPageTpl = async (pageData) => {
        const r = await Tpl.createPage(notion, pageData);
        if (r.templated) templated++;
        else { tplFallback++; if (!tplFallbackReason) tplFallbackReason = r.fallbackReason; }
        return r.page;
    };

    // 요청 하나가 응답을 안 줘도 함수 전체(60초)가 멈추지 않도록, 남은 시간 안에서만 기다린다.
    // (시간이 지나도 노션에서는 계속 처리 중일 수 있다)
    const withDeadline = (promise) => {
        let timer;
        const ms = Math.max(3000, BUDGET_MS - (Date.now() - startedAt));
        const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('응답 지연: 노션에서 계속 처리 중일 수 있습니다')), ms); });
        return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
    };

    // 이미 있는 페이지: '비우고 다시 적용'이 켜져 있으면 본문을 지우고 템플릿을 새로 적용,
    // 아니면 본문이 비어 있을 때만 템플릿을 적용한다. 반환값: 템플릿을 적용했는가
    const fillExisting = async (existing, title) => {
        if (!existing) return false;
        try {
            return await withDeadline((async () => {
                if (eraseTemplate) { await Tpl.applyDefaultTemplate(notion, existing.id, { erase: true }); reapplied.push(title); return true; }
                if (existing.edited && Date.now() - new Date(existing.edited).getTime() < RECENT_EDIT_MS) return false;
                if (await Tpl.isBodyEmpty(notion, existing.id)) { await Tpl.applyDefaultTemplate(notion, existing.id); filled.push(title); return true; }
                return false;
            })());
        } catch (e) {
            if (tplWarnings.length < 3) tplWarnings.push(`${title}: 템플릿 적용 실패 (${String(e.message || e).replace(/\s+/g, ' ').slice(0, 100)})`);
        }
        return false;
    };

    // 예산을 넘기면 남은 항목은 시작하지 않고 안내만 남긴다. (페이지가 크면 '본문 비우기' 한 건이 수십 초 걸릴 수 있다)
    let notProcessed = 0;
    const overBudget = () => Date.now() - startedAt > BUDGET_MS;

    // 노션 요청 제한(평균 초당 3회)을 넘지 않도록 동시에 2개씩만 처리한다.
    const runPool = async (tasks, concurrency = 2, gapMs = 250) => {
        let i = 0;
        const worker = async () => {
            while (i < tasks.length) {
                if (overBudget()) { notProcessed += tasks.length - i; i = tasks.length; break; }
                const t = tasks[i++]; await t(); await delay(gapMs);
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
    };

    // Annual/Monthly/Weekly/Daily 공통: 제목이 아니라 Schedule 날짜로 기존 페이지를
    // 찾는다. 사용자가 노션 템플릿 버튼으로 미리 만들어둔 빈 페이지는 제목이 없어서
    // 제목 기준으로는 "없는 날"로 오인되어 중복 생성될 수 있다. 그런 페이지는 날짜만
    // 맞으면 새로 만들지 않고 찾아서 제목을 채워 넣는다.
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
                if (sDate) map.set(sDate.substring(0, 10), { id: p.id, title: extractTitle(p.properties), start: sDate.substring(0, 10), coverUrl: p.cover?.external?.url || null, edited: p.last_edited_time || null });
            });
            hasMore = response.has_more; cursor = response.next_cursor;
        }
        return map;
    };

    // 같은 날짜로 이미 있는 페이지 처리:
    //  1) 제목이 비어 있으면 제목을 채운다.
    //  2) '커버 덮어쓰기'가 켜져 있으면 날짜에 맞는 헤더 이미지로 바꾼다 (맞는 이미지가 없거나 이미 같으면 그대로).
    //  3) 본문이 비어 있으면 Auto_fill 템플릿을 적용한다 ('비우고 다시 적용'이 켜져 있으면 본문을 지우고 다시 적용).
    const handleExisting = async (existing, titleProp, title, cover, label = title) => {
        const patch = {};
        const needTitle = !existing.title;
        if (needTitle) patch.properties = { [titleProp]: { title: [{ text: { content: title } }] } };
        const needCover = !!cover && overwrite && existing.start >= MIN_OVERWRITE_DATE
            && !(existing.coverUrl && Headers.pathOf(existing.coverUrl) === Headers.pathOf(cover.external.url));
        if (needCover) patch.cover = cover;
        if (Object.keys(patch).length) await notion.pages.update({ page_id: existing.id, ...patch });
        const tplDone = await fillExisting(existing, label);
        if (needTitle) adopted.push(label);
        if (needCover) recovered.push(label);
        if (!needTitle && !needCover && !tplDone) skipped.push(label);
    };

    // 새 페이지 생성 (아이콘은 기본 아이콘, 커버는 날짜에 맞는 헤더 이미지가 있을 때만)
    const createNew = async (dbId, titleProp, title, start, end, iconUrl, cover) => {
        const pageData = { parent: { database_id: dbId }, properties: { [titleProp]: { title: [{ text: { content: title } }] }, "Schedule": { date: { start: start, end: end || null } } } };
        if (iconUrl) pageData.icon = { type: 'external', external: { url: iconUrl } };
        if (cover) { pageData.cover = cover; covered++; }
        await createPageTpl(pageData);
    };

    if (type === 'year_month') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exAnn = doPersonal ? await getExistingByDate(ANNUAL_DB_ID, yStart, yEnd) : new Map();
        const exMon = doPersonal ? await getExistingByDate(MONTHLY_DB_ID, yStart, yEnd) : new Map();
        const exFinMon = doFinance ? await getExistingByDate(FINANCE_MONTHLY_DB_ID, yStart, yEnd) : new Map();

        const createFast = async (dbId, title, start, end, existingByDate, iconUrl, coverFn) => {
            if (!dbId) return;
            const titleProp = await getTitleProp(dbId);
            const existing = existingByDate.get(start);
            if (existing) {
                const cover = overwrite && coverFn ? Headers.externalCover(await coverFn()) : undefined;
                await handleExisting(existing, titleProp, title, cover);
                return;
            }
            const cover = coverFn ? Headers.externalCover(await coverFn()) : undefined;
            await createNew(dbId, titleProp, title, start, end, iconUrl, cover);
            created.push(title);
        };

        // 한 번에 25건을 처리하면 오래 걸려 60초 제한에 걸릴 수 있어 나눠 호출할 수 있게 한다.
        //  part=annual → 연간만 / month=1~12 → 그 달(Personal+Finance)만 / 둘 다 없으면 전부
        const onlyAnnual = part === 'annual';
        const ymMonth = parseInt(month) || 0;
        const ymTasks = [];
        // 연간 헤더: headers/personal/year 의 띠 이미지 (2027년 = 양띠 08번)
        if (doPersonal && (onlyAnnual || ymMonth === 0)) ymTasks.push(() => createFast(ANNUAL_DB_ID, `${targetYear}년`, `${targetYear}-01-01`, `${targetYear}-12-31`, exAnn, ICON_YEAR_MONTH, () => Headers.yearCoverUrl(assetBase, targetYear)));
        for (let m = 1; m <= 12 && !onlyAnnual; m++) {
            if (ymMonth && ymMonth !== m) continue;
            const dt = DateTime.local(targetYear, m, 1);
            const mTitle = dt.toFormat('MM월');
            // 헤더 이미지: Personal은 personal 폴더, Finance는 finance 폴더 (그 해 전용 세트가 있으면 그것, 없으면 default)
            if (doPersonal) ymTasks.push(() => createFast(MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exMon, ICON_YEAR_MONTH, () => Headers.monthCoverUrl(assetBase, dt.toISODate(), false)));
            if (doFinance) ymTasks.push(() => createFast(FINANCE_MONTHLY_DB_ID, mTitle, dt.toISODate(), dt.endOf('month').toISODate(), exFinMon, ICON_YEAR_MONTH, () => Headers.monthCoverUrl(assetBase, dt.toISODate(), true)));
        }
        await runPool(ymTasks);
    }

    if (type === 'weeks') {
        const yStart = `${targetYear-1}-11-01`; const yEnd = `${targetYear+1}-02-28`;
        const exWeek = doPersonal ? await getExistingByDate(WEEKLY_DB_ID, yStart, yEnd) : new Map();
        const exFinWeek = doFinance ? await getExistingByDate(FINANCE_WEEKLY_DB_ID, yStart, yEnd) : new Map();
        const weekTitleProp = await getTitleProp(WEEKLY_DB_ID);
        const finWeekTitleProp = await getTitleProp(FINANCE_WEEKLY_DB_ID);

        const totalWeeks = DateTime.local(targetYear, 12, 28).weekNumber;

        for (let w = 1; w <= totalWeeks; w++) {
            const dt = DateTime.fromObject({ weekYear: targetYear, weekNumber: w, weekday: 1 });
            if (month && parseInt(month) > 0 && dt.month !== parseInt(month)) continue;
            if (overBudget()) { notProcessed++; continue; }

            const wTitle = `${dt.toFormat('yy')}. ${dt.toFormat('MM')}. - w${w}`;
            const startIso = dt.toISODate(); const endIso = dt.plus({ days: 6 }).toISODate();

            // 헤더 이미지: Personal은 personal 폴더, Finance는 finance 폴더 (그 달의 몇째 주인지에 맞춰 선택)
            const jobs = [];
            if (doPersonal && WEEKLY_DB_ID) jobs.push({ dbId: WEEKLY_DB_ID, ex: exWeek, isFin: false, titleProp: weekTitleProp, label: wTitle });
            if (doFinance && FINANCE_WEEKLY_DB_ID) jobs.push({ dbId: FINANCE_WEEKLY_DB_ID, ex: exFinWeek, isFin: true, titleProp: finWeekTitleProp, label: `${wTitle} (Finance)` });

            for (const job of jobs) {
                const existing = job.ex.get(startIso);
                const coverFn = () => Headers.weekCoverUrl(assetBase, startIso, job.isFin);
                if (existing) {
                    const cover = overwrite ? Headers.externalCover(await coverFn()) : undefined;
                    await handleExisting(existing, job.titleProp, wTitle, cover, job.label);
                } else {
                    const cover = Headers.externalCover(await coverFn());
                    await createNew(job.dbId, job.titleProp, wTitle, startIso, endIso, ICON_WEEK, cover);
                    created.push(job.label);
                }
            }
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
                // 같은 날짜의 페이지가 이미 있음 (노션 템플릿 버튼으로 미리 만들어둔 빈 페이지일 수 있음).
                // 중복 생성하지 않고, 제목 채우기 / (옵션) 헤더 이미지 덮어쓰기 / 빈 본문에 Auto_fill 적용만 한다.
                const existingCover = overwrite ? Headers.externalCover(await Headers.dayCoverUrl(assetBase, dateKey)) : undefined;
                tasks.push(() => handleExisting(existing, dailyTitleProp, dTitle, existingCover));
                continue;
            }

            // 헤더 이미지: 요일에 맞는 이미지 (월~일). 아이콘은 기본 아이콘.
            const dayCover = Headers.externalCover(await Headers.dayCoverUrl(assetBase, dateKey));
            tasks.push(async () => {
                if(!DAILY_DB_ID) return;
                await createNew(DAILY_DB_ID, dailyTitleProp, dTitle, dateKey, null, getDailyIcon(dayNameStr), dayCover);
                created.push(dTitle);
            });
        }

        await runPool(tasks);
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

    const tplText = ` / Auto_fill 적용: 새 페이지 ${templated}, 빈 페이지 ${filled.length}, 비우고 재적용 ${reapplied.length}`;
    const warns = tplFallback ? [`템플릿 없이 생성 ${tplFallback}건 (${tplFallbackReason})`, ...tplWarnings] : tplWarnings;
    if (notProcessed) warns.push(`⏱️ 시간 제한으로 ${notProcessed}건을 처리하지 못했습니다. 같은 버튼을 다시 눌러 이어서 처리하세요`);
    const warnText = warns.length ? ` / ⚠️ ${warns.join(' | ')}` : '';
    res.status(200).json({ success: true, partial: notProcessed > 0, message: `생성: ${created.length} / 헤더 이미지 적용: ${covered} / 기존 커버 덮어씀: ${recovered.length} / 빈 페이지 채움: ${adopted.length} / 스킵: ${skipped.length}${tplText}${warnText}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
