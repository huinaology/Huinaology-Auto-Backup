// lib/headers.js
// Weekly/Daily/Monthly 페이지 헤더(커버) 이미지를 날짜에 맞춰 고른다.
//  - Weekly : (월-1)*5 + "그 주 월요일이 그 달의 몇째 주인지" → 01~60번 (personal / finance 폴더)
//             월요일이 29~31일인 주만 5번째 주가 되므로, 월요일이 4번뿐인 달은 5번 이미지를 쓰지 않는다.
//  - Daily  : 요일 → 1(월)~7(일)번 (personal 폴더만 있음)
//  - Monthly: 월 → 01~12번 (personal / finance 폴더)
//  - Annual : 해(年)의 띠 → headers/personal/year/01~12.png (연도 폴더 없음. 2027년 = 양띠 = 08번)
// 폴더 구조: headers/{personal|finance}/{week|month|day}/{YYYY|default}/파일
//  (personal = Personal DB용, finance = Finance DB용)
//  - 그 해 폴더({YYYY})가 있으면 그 이미지를, 없으면 default 폴더를, 둘 다 없으면 커버를 넣지 않는다.
//  - 폴더는 세트 전체(week 60장 / month 12장 / day 7장)를 한꺼번에 올린다.
// 이미지 파일은 이 프로젝트의 /headers 폴더에 들어 있고, 각자 배포한 Vercel 주소로 서빙된다.
const { DateTime } = require('luxon');

function getAssetBase(req) {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
        || req.headers['x-forwarded-host']
        || req.headers.host;
    return host ? `https://${host}` : null;
}

// 파일이 실제로 있는지 HEAD로 확인한다. 응답을 받은 결과만 같은 서버 인스턴스에서 재사용한다
// (네트워크 오류는 캐시하지 않아서 다음 실행에서 다시 확인한다).
const probeCache = new Map();
async function urlExists(url) {
    if (probeCache.has(url)) return probeCache.get(url);
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(timer);
        probeCache.set(url, r.ok);
        return r.ok;
    } catch (e) { return false; }
}

// 폴더 하나(테마/종류/연도)당 한 번만 확인한다: 그 해 폴더 → default → 없음(null)
async function pickFolder(base, theme, kind, year, probeFile) {
    const root = `${base}/headers/${theme}/${kind}`;
    if (await urlExists(`${root}/${year}/${probeFile}`)) return `${root}/${year}`;
    if (await urlExists(`${root}/default/${probeFile}`)) return `${root}/default`;
    return null;
}

async function weekCoverUrl(base, startISO, isFinance) {
    const d = DateTime.fromISO(String(startISO).substring(0, 10));
    if (!base || !d.isValid) return null;
    const dir = await pickFolder(base, isFinance ? 'finance' : 'personal', 'week', d.year, '01.png');
    if (!dir) return null;
    const idx = (d.month - 1) * 5 + Math.ceil(d.day / 7);
    const url = `${dir}/${String(idx).padStart(2, '0')}.png`;
    return (await urlExists(url)) ? url : null; // 해당 주 이미지가 없으면 깨진 커버 대신 커버 없음
}

// Annual: headers/personal/year/{01~12}.png 를 해(年)의 띠에 맞춰 고른다. (2027년 = 양띠 = 08번)
//  띠 순서: 1 쥐, 2 소, 3 호랑이, 4 토끼, 5 용, 6 뱀, 7 말, 8 양, 9 원숭이, 10 닭, 11 개, 12 돼지
async function yearCoverUrl(base, year) {
    const y = parseInt(year, 10);
    if (!base || !Number.isFinite(y)) return null;
    const idx = (((y - 4) % 12) + 12) % 12 + 1;
    const url = `${base}/headers/personal/year/${String(idx).padStart(2, '0')}.png`;
    return (await urlExists(url)) ? url : null;
}

async function dayCoverUrl(base, dateISO) {
    const d = DateTime.fromISO(String(dateISO).substring(0, 10));
    if (!base || !d.isValid) return null;
    const dir = await pickFolder(base, 'personal', 'day', d.year, '1.png');
    return dir ? `${dir}/${d.weekday}.png` : null;
}

async function monthCoverUrl(base, dateISO, isFinance) {
    const d = DateTime.fromISO(String(dateISO).substring(0, 10));
    if (!base || !d.isValid) return null;
    const dir = await pickFolder(base, isFinance ? 'finance' : 'personal', 'month', d.year, '01.png');
    return dir ? `${dir}/${String(d.month).padStart(2, '0')}.png` : null;
}

const externalCover = (url) => (url ? { type: 'external', external: { url } } : undefined);
const pathOf = (url) => { try { return new URL(url).pathname; } catch (e) { return url; } };

module.exports = { getAssetBase, weekCoverUrl, dayCoverUrl, monthCoverUrl, yearCoverUrl, externalCover, pathOf, urlExists };
