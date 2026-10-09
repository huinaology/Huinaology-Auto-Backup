// api/holidays.js
// 법정공휴일 / 기타기념일 / 24절기(+한식) 자동 생성
// - Personal Master DB에 지정한 연도의 항목들을 생성한다.
// - 이미 같은 제목의 항목이 그 해에 있으면 건너뛴다 (중복 생성 방지).
const { Client } = require('@notionhq/client');
const { DateTime } = require('luxon');
const Config = require('../lib/config');

// =====================================================================
// 아이콘 규칙
//   법정공휴일(휴무일)   : 빨간색 day calendar
//   기타 기념일(휴무 아님): 파란색 day calendar
//   24절기(+한식)        : 노란색 orbit
//   개별 지정            : 식목일=초록 화분 / 어버이날=파란 선물상자 /
//                          할로윈=호박 / 크리스마스=빨간 트리
// =====================================================================
const RED = 'ef4444';
const BLUE = '3b82f6';
const YELLOW = 'eab308';

const ICONS = {
    holiday: { type: 'external', external: { url: `https://api.iconify.design/lucide/calendar-days.svg?color=%23${RED}` } },
    other:   { type: 'external', external: { url: `https://api.iconify.design/lucide/calendar-days.svg?color=%23${BLUE}` } },
    term:    { type: 'external', external: { url: `https://api.iconify.design/lucide/orbit.svg?color=%23${YELLOW}` } },
    plant:   { type: 'emoji', emoji: '🪴' },
    gift:    { type: 'external', external: { url: `https://api.iconify.design/lucide/gift.svg?color=%23${BLUE}` } },
    pumpkin: { type: 'emoji', emoji: '🎃' },
    xmas:    { type: 'external', external: { url: `https://api.iconify.design/lucide/tree-pine.svg?color=%23${RED}` } },
};

const ICON_OVERRIDE = {
    '식목일': 'plant',
    '어버이날': 'gift',
    '할로윈': 'pumpkin',
    '크리스마스': 'xmas',
};

function iconFor(title, cat) {
    if (ICON_OVERRIDE[title]) return ICONS[ICON_OVERRIDE[title]];
    return ICONS[cat] || ICONS.other;
}

// Notion 수식(equation) 텍스트로 빨간 "Holiday" 뱃지를 만든다.
function holidayBadgeRichText() {
    return [{
        type: 'equation',
        equation: { expression: '\\fcolorbox{900000}{900000}{\\color{white}{\\enspace Holiday\\enspace}}' }
    }];
}

// =====================================================================
// [음력 입력 규칙 - 반드시 읽어주세요]
//   설날(구정) / 추석 / 부처님 오신날은 음력 기준 날짜라서, 해마다 양력으로
//   몇 월 며칠인지가 계산식으로 딱 떨어지지 않습니다 (음력 자체가 윤달이
//   끼는 등 규칙이 복잡해서, 정확한 변환에는 공식 음력 데이터가 필요합니다).
//
//   그래서 이 파일은 두 단계로 나눠서 동작합니다.
//     1) YEAR_DATA 표에 그 해의 "확정" 날짜를 사람이 직접 입력해둔다.
//        (정부가 매년 발표하는 관공서 공휴일 규정을 참고해서 입력)
//        - t   : 항목 이름
//        - s   : 시작일 (YYYY-MM-DD)
//        - e   : 연휴 마지막날 (하루짜리면 생략 가능)
//        - cat : 'holiday'(법정공휴일) | 'other'(기념일) | 'term'(24절기)
//     2) YEAR_DATA에 없는 연도는 아래 computeYear()가 자동으로 채웁니다.
//        - KASI_API_KEY 환경변수가 설정되어 있으면: 법정공휴일 전체(대체공휴일 포함,
//          설날/추석/부처님오신날 음력 3종 포함) + 24절기 + 한식/초복/중복/말복/단오를
//          한국천문연구원 API로 매년 자동으로 정확하게 조회해 채웁니다. 별도 코드
//          수정이 필요 없습니다. (근로자의 날만은 근로기준법 소관이라 이 API 대상이
//          아니므로 항상 고정 날짜로 생성됩니다.)
//        - 설정되어 있지 않거나 호출이 실패하면: 예전과 동일하게 고정 날짜 +
//          근사치 24절기 + 자체 대체공휴일 계산으로 동작하고, 설날/추석/부처님오신날은
//          생성하지 않고 안내 로그만 남깁니다. 이 경우 YEAR_DATA 표에 그 해의
//          음력 3종 날짜를 직접 추가해줘야 합니다.
//
//   [KASI_API_KEY 발급 방법]
//   한국천문연구원이 공공데이터포털을 통해 제공하는 "특일 정보" 오픈API를
//   신청하면, 음력↔양력 변환과 공휴일 정보를 매년 직접 입력하지 않아도
//   API 응답 기준으로 정확하게 가져올 수 있습니다.
//     - 신청/설명 페이지: https://www.data.go.kr/data/15012690/openapi.do
//     - 공공데이터포털(data.go.kr) 로그인 → 위 페이지에서 "활용신청" →
//       발급된 "일반 인증키(Decoding)"를 Vercel 프로젝트의 환경변수
//       KASI_API_KEY 에 등록 → 재배포. 이후 위젯 코드는 그대로 두고
//       Holiday Generator를 실행하면 자동으로 API 기준으로 전환됩니다.
// =====================================================================
const YEAR_DATA = {
    2026: [
        { t: '신정', s: '2026-01-01', cat: 'holiday' },
        { t: '소한', s: '2026-01-05', cat: 'term' },
        { t: '대한', s: '2026-01-20', cat: 'term' },
        { t: '입춘', s: '2026-02-04', cat: 'term' },
        { t: '구정', s: '2026-02-16', e: '2026-02-18', cat: 'holiday' },
        { t: '우수', s: '2026-02-19', cat: 'term' },
        { t: '삼일절', s: '2026-03-01', e: '2026-03-02', cat: 'holiday' },
        { t: '경칩', s: '2026-03-05', cat: 'term' },
        { t: '춘분', s: '2026-03-20', cat: 'term' },
        { t: '식목일', s: '2026-04-05', cat: 'other' },
        { t: '청명', s: '2026-04-05', cat: 'term' },
        { t: '한식', s: '2026-04-06', cat: 'term' },
        { t: '곡우', s: '2026-04-20', cat: 'term' },
        { t: '근로자의 날', s: '2026-05-01', cat: 'holiday' },
        { t: '어린이날', s: '2026-05-05', cat: 'holiday' },
        { t: '어버이날', s: '2026-05-08', cat: 'other' },
        { t: '소만', s: '2026-05-21', cat: 'term' },
        { t: '부처님 오신날', s: '2026-05-24', e: '2026-05-25', cat: 'holiday' },
        { t: '현충일', s: '2026-06-06', cat: 'holiday' },
        { t: '단오', s: '2026-06-19', cat: 'term' },
        { t: '하지', s: '2026-06-21', cat: 'term' },
        { t: '소서', s: '2026-07-07', cat: 'term' },
        { t: '초복', s: '2026-07-15', cat: 'term' },
        { t: '제헌절', s: '2026-07-17', cat: 'other' },
        { t: '중복', s: '2026-07-25', cat: 'term' },
        { t: '입추', s: '2026-08-07', cat: 'term' },
        { t: '말복', s: '2026-08-14', cat: 'term' },
        { t: '광복절', s: '2026-08-15', e: '2026-08-17', cat: 'holiday' },
        { t: '처서', s: '2026-08-23', cat: 'term' },
        { t: '백로', s: '2026-09-07', cat: 'term' },
        { t: '추분', s: '2026-09-23', cat: 'term' },
        { t: '추석', s: '2026-09-24', e: '2026-09-27', cat: 'holiday' },
        { t: '개천절', s: '2026-10-03', e: '2026-10-05', cat: 'holiday' },
        { t: '한로', s: '2026-10-08', cat: 'term' },
        { t: '한글날', s: '2026-10-09', cat: 'holiday' },
        { t: '상강', s: '2026-10-23', cat: 'term' },
        { t: '할로윈', s: '2026-10-31', cat: 'other' },
        { t: '입동', s: '2026-11-07', cat: 'term' },
        { t: '소설', s: '2026-11-22', cat: 'term' },
        { t: '대설', s: '2026-12-07', cat: 'term' },
        { t: '동지', s: '2026-12-22', cat: 'term' },
        { t: '크리스마스', s: '2026-12-25', cat: 'holiday' },
    ]
};

// 고정 날짜(양력) 항목 - 음력 3종(설날/추석/부처님오신날) 제외
const FIXED_ITEMS = [
    { t: '신정', md: '01-01', cat: 'holiday' },
    { t: '삼일절', md: '03-01', cat: 'holiday' },
    { t: '식목일', md: '04-05', cat: 'other' },
    { t: '근로자의 날', md: '05-01', cat: 'holiday' },
    { t: '어린이날', md: '05-05', cat: 'holiday' },
    { t: '어버이날', md: '05-08', cat: 'other' },
    { t: '현충일', md: '06-06', cat: 'holiday' },
    { t: '제헌절', md: '07-17', cat: 'other' },
    { t: '광복절', md: '08-15', cat: 'holiday' },
    { t: '개천절', md: '10-03', cat: 'holiday' },
    { t: '한글날', md: '10-09', cat: 'holiday' },
    { t: '할로윈', md: '10-31', cat: 'other' },
    { t: '크리스마스', md: '12-25', cat: 'holiday' },
];
// 대체공휴일 대상(국경일 4개 + 어린이날 + 부처님오신날 + 크리스마스)
// 신정 / 현충일 / 근로자의날 은 대체공휴일 대상이 아님
const SUB_HOLIDAY_ELIGIBLE = new Set(['삼일절', '어린이날', '광복절', '개천절', '한글날', '크리스마스']);

// 24절기 + 한식 (평년 기준 근사치 - 해마다 최대 ±1일 오차 가능)
const TERM_ITEMS = [
    { t: '소한', md: '01-05' }, { t: '대한', md: '01-20' }, { t: '입춘', md: '02-04' },
    { t: '우수', md: '02-19' }, { t: '경칩', md: '03-05' }, { t: '춘분', md: '03-20' },
    { t: '청명', md: '04-05' }, { t: '한식', md: '04-06' }, { t: '곡우', md: '04-20' },
    { t: '입하', md: '05-05' }, { t: '소만', md: '05-21' }, { t: '망종', md: '06-05' },
    { t: '하지', md: '06-21' }, { t: '소서', md: '07-07' }, { t: '초복', md: '07-15' },
    { t: '대서', md: '07-22' }, { t: '중복', md: '07-25' }, { t: '입추', md: '08-07' },
    { t: '말복', md: '08-14' }, { t: '처서', md: '08-23' }, { t: '백로', md: '09-07' },
    { t: '추분', md: '09-23' }, { t: '한로', md: '10-08' }, { t: '상강', md: '10-23' },
    { t: '입동', md: '11-07' }, { t: '소설', md: '11-22' }, { t: '대설', md: '12-07' },
    { t: '동지', md: '12-22' },
];

function nextFreeWeekday(dt, usedDates) {
    let d = dt;
    while (d.weekday === 6 || d.weekday === 7 || usedDates.has(d.toISODate())) {
        d = d.plus({ days: 1 });
    }
    return d;
}

// =====================================================================
// 한국천문연구원 "특일 정보" API — 설날/추석/부처님오신날(음력) 날짜 조회 (선택 사항).
//   KASI_API_KEY 환경변수를 설정하면, 표에 없는 연도도 이 API로 (1) 법정공휴일
//   전체(대체공휴일 포함, 음력 3종 포함), (2) 24절기, (3) 한식/초복/중복/말복/단오 등
//   잡절까지 전부 정확하게 채운다. API가 실제로 그 해 정부 고시 기준 날짜를 돌려주므로,
//   대체공휴일도 자체 요일 계산(nextFreeWeekday) 없이 API 응답을 그대로 신뢰한다.
//   설정하지 않았거나 호출이 실패하면, 기존처럼 고정 날짜 + 근사치 24절기/잡절 +
//   자체 대체공휴일 계산으로 조용히 대체된다 (동작 자체가 끊기지 않음).
//   ※ 근로자의 날은 "근로기준법" 소관이라 이 API(관공서 공휴일 규정 기준) 대상이
//     아니므로, API 사용 여부와 무관하게 항상 고정 날짜로 생성한다.
// =====================================================================
const KASI_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService';

async function fetchKasiOperation(operation, year) {
    const apiKey = Config.ENV.KASI_API_KEY;
    if (!apiKey) return { items: null, error: null }; // 키 미설정 → 조용히 스킵 (기존 동작과 동일)

    // data.go.kr 서비스키는 "일반 인증키(Decoding)"를 그대로 써야 한다.
    // "URL 인증키(Encoding)"를 넣으면 이미 %XX 로 인코딩된 문자열을 또 인코딩해버려 키가 깨진다.
    if (apiKey.includes('%')) {
        return { items: null, error: "KASI_API_KEY가 URL 인코딩된 키로 보입니다. data.go.kr 마이페이지 > 개발계정 상세보기에서 '일반 인증키(Decoding)'을 복사해 다시 등록해주세요." };
    }

    const url = `${KASI_BASE}/${operation}?serviceKey=${apiKey}&solYear=${year}&numOfRows=100&_type=json`;

    let text;
    try {
        const resp = await fetch(url);
        text = await resp.text();
    } catch (e) {
        return { items: null, error: `KASI API(${operation}) 요청 실패(네트워크): ${e.message}` };
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return { items: null, error: `KASI API(${operation}) 응답이 JSON이 아닙니다(키 미승인/오류 가능성). 응답 앞부분: ${text.slice(0, 150)}` };
    }

    const header = data?.response?.header;
    if (!header || header.resultCode !== '00') {
        return { items: null, error: `KASI API(${operation}) 오류: ${header?.resultMsg || '알 수 없는 오류'} (code ${header?.resultCode})` };
    }

    const raw = data?.response?.body?.items?.item;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return { items: list, error: null };
}

const fetchKasiHoliDeInfo = (year) => fetchKasiOperation('getHoliDeInfo', year);       // 법정공휴일(대체공휴일 포함)
const fetchKasi24Divisions = (year) => fetchKasiOperation('get24DivisionsInfo', year); // 24절기
const fetchKasiSundryDay = (year) => fetchKasiOperation('getSundryDayInfo', year);     // 잡절(한식/초복/중복/말복/단오 등)

// locdate(YYYYMMDD, 숫자 또는 문자열)를 YYYY-MM-DD로 변환한다.
function locdateToISO(locdate) {
    const d = String(locdate);
    return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

// 표에 없는 연도: KASI_API_KEY가 있으면 공휴일 전체(대체공휴일 포함)/24절기/잡절을
// API로 채우고, 없거나 호출이 실패하면 기존의 고정 날짜 + 근사치 계산으로 대체한다.
async function computeYear(year) {
    const items = [];
    const usedDates = new Set();
    const warnings = [];

    // 근로자의 날: API 대상이 아니므로 항상 고정 계산.
    const laborDay = FIXED_ITEMS.find(f => f.t === '근로자의 날');
    if (laborDay) {
        const dt = DateTime.fromISO(`${year}-${laborDay.md}`);
        items.push({ t: laborDay.t, s: dt.toISODate(), cat: laborDay.cat });
        usedDates.add(dt.toISODate());
    }

    // "다른 뭔가"(식목일/어버이날/제헌절/할로윈)는 법정공휴일이 아니라 이 API 대상이
    // 아니므로 항상 고정 날짜로 생성한다.
    FIXED_ITEMS.forEach(f => {
        if (f.cat !== 'other') return;
        const dt = DateTime.fromISO(`${year}-${f.md}`);
        items.push({ t: f.t, s: dt.toISODate(), cat: f.cat });
        usedDates.add(dt.toISODate());
    });

    // ---- 법정공휴일(신정/설날/삼일절/어린이날/현충일/광복절/추석/개천절/한글날/
    //      크리스마스/부처님오신날 + 대체공휴일) ----
    const { items: kasiHolidays, error: holidayError } = await fetchKasiHoliDeInfo(year);
    if (kasiHolidays) {
        const byName = new Map(); // dateName -> ISO 날짜 배열
        kasiHolidays.forEach(it => {
            if (it.isHoliday !== 'Y') return;
            const iso = locdateToISO(it.locdate);
            if (!iso) return;
            const name = it.dateName || '공휴일';
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(iso);
        });
        byName.forEach((dates, name) => {
            dates.sort();
            dates.forEach(d => usedDates.add(d));
            items.push({ t: name, s: dates[0], e: dates.length > 1 ? dates[dates.length - 1] : undefined, cat: 'holiday' });
        });
        if (byName.size === 0) warnings.push(`⚠️ ${year}년 법정공휴일 정보를 KASI API 응답에서 찾지 못했습니다.`);
    } else {
        // API 미설정/실패 → 기존 방식(고정 날짜 + 자체 대체공휴일 계산)으로 대체.
        if (holidayError) warnings.push(`⚠️ 법정공휴일 정보를 KASI API 호출 실패로 가져오지 못해, 고정 날짜 계산 방식으로 대체합니다: ${holidayError}`);
        else warnings.push(`ℹ️ KASI_API_KEY가 설정되지 않아 법정공휴일(대체공휴일 포함)·설날·추석·부처님오신날은 고정 날짜 계산 방식으로 대체됩니다. YEAR_DATA에 정확한 날짜를 직접 추가하거나, KASI_API_KEY를 등록하면 자동으로 정확하게 채워집니다.`);

        FIXED_ITEMS.forEach(f => {
            if (f.cat !== 'holiday') return; // 근로자의 날은 이미 위에서 추가함
            const dt = DateTime.fromISO(`${year}-${f.md}`);
            usedDates.add(dt.toISODate());
            items.push({ t: f.t, s: dt.toISODate(), cat: f.cat, _dt: dt });
        });
        items.forEach(it => {
            if (!it._dt) return;
            if (!SUB_HOLIDAY_ELIGIBLE.has(it.t)) return;
            if (it._dt.weekday !== 6 && it._dt.weekday !== 7) return;
            const sub = nextFreeWeekday(it._dt.plus({ days: 1 }), usedDates);
            usedDates.add(sub.toISODate());
            it.e = sub.toISODate();
        });
        items.forEach(it => delete it._dt);
    }

    // ---- 24절기 ----
    const { items: kasiTerms, error: termError } = await fetchKasi24Divisions(year);
    if (kasiTerms) {
        const termByName = new Map();
        kasiTerms.forEach(it => {
            const iso = locdateToISO(it.locdate);
            if (iso && it.dateName) termByName.set(it.dateName, iso);
        });
        TERM_ITEMS.forEach(term => {
            items.push({ t: term.t, s: termByName.get(term.t) || `${year}-${term.md}`, cat: 'term' });
        });
        if (termByName.size === 0) warnings.push(`⚠️ ${year}년 24절기 정보를 KASI API 응답에서 찾지 못해 근사치 날짜를 사용합니다.`);
    } else {
        if (termError) warnings.push(`⚠️ 24절기 정보를 KASI API 호출 실패로 가져오지 못해, 근사치 날짜(±1일 오차 가능)를 사용합니다: ${termError}`);
        TERM_ITEMS.forEach(term => {
            items.push({ t: term.t, s: `${year}-${term.md}`, cat: 'term' });
        });
    }

    // ---- 잡절(한식/초복/중복/말복/단오) ----
    // 이 5개는 TERM_ITEMS에 근사치로 이미 들어가 있으므로, API가 주는 정확한 날짜로 덮어쓴다.
    const { items: kasiSundry, error: sundryError } = await fetchKasiSundryDay(year);
    if (kasiSundry) {
        const sundryNames = new Set(['한식', '초복', '중복', '말복', '단오']);
        kasiSundry.forEach(it => {
            const name = it.dateName;
            if (!name || !sundryNames.has(name)) return;
            const iso = locdateToISO(it.locdate);
            if (!iso) return;
            const idx = items.findIndex(i => i.cat === 'term' && i.t === name);
            if (idx >= 0) items[idx].s = iso; // 근사치를 API의 정확한 날짜로 교체
        });
    } else if (sundryError) {
        warnings.push(`⚠️ 한식/초복/중복/말복/단오 정보를 KASI API 호출 실패로 가져오지 못해, 근사치 날짜(±1일 오차 가능)를 사용합니다: ${sundryError}`);
    }

    return { items, warnings };
}

async function getYearItems(year) {
    if (YEAR_DATA[year]) return { items: YEAR_DATA[year], verified: true, warnings: [] };
    const { items, warnings } = await computeYear(year);
    return { items, verified: false, warnings };
}

const extractTitle = (properties) => {
    if (!properties) return '';
    const key = Object.keys(properties).find(k => properties[k].type === 'title');
    if (!key || !properties[key].title || properties[key].title.length === 0) return '';
    return properties[key].title.map(t => t.plain_text).join('');
};

// "Contents" 관계 속성에 연결할 태그 페이지("Event & Holiday"). 사용자가 제목을
// 바꿀 수도 있으니 정확히 일치가 아니라 "Holiday" 단어가 포함되면 연결한다.
// 찾는 방법은 두 단계로 시도한다.
//   1) Contents 관계 속성이 실제로 가리키는 DB를 직접 조회(databases.query) -
//      워크스페이스 전체 검색(search)보다 빠르고 확실하다. 이 DB가 위젯의 Notion
//      통합(Connections)에 공유되어 있지 않으면 여기서 권한 오류가 나는데, 그
//      사실 자체가 중요한 진단 정보라 diagnostics에 남긴다.
//   2) 위 방법이 실패하면 워크스페이스 전체 검색으로 한 번 더 시도한다(폴백).
//      단, 통합에 공유되지 않은 페이지는 검색으로도 찾을 수 없다 - 이 경우
//      Notion에서 해당 페이지(또는 상위 DB)를 열어 "..." → Connections에서
//      이 위젯의 통합을 연결해줘야 한다.
const CONTENTS_HOLIDAY_KEYWORD = 'Holiday';

async function findHolidayTagId(notion, dbInfo, contentsProp, keyword) {
    const diagnostics = [];
    const targetDbId = contentsProp ? dbInfo.properties[contentsProp]?.relation?.database_id : null;

    if (targetDbId) {
        try {
            const targetDbInfo = await notion.databases.retrieve({ database_id: targetDbId });
            const targetTitleProp = Object.keys(targetDbInfo.properties).find(k => targetDbInfo.properties[k].type === 'title');
            if (targetTitleProp) {
                const res = await notion.databases.query({
                    database_id: targetDbId,
                    filter: { property: targetTitleProp, title: { contains: keyword } },
                    page_size: 5
                });
                if (res.results[0]) return { id: res.results[0].id, diagnostics };
            }
            diagnostics.push(`Contents가 가리키는 DB(${targetDbId})에서 "${keyword}" 포함 페이지를 찾지 못함`);
        } catch (e) {
            diagnostics.push(`Contents가 가리키는 DB(${targetDbId})에 접근할 수 없음: ${e.message} → 이 DB(또는 상위 페이지)가 위젯의 Notion 통합(Connections)에 공유되어 있는지 확인 필요`);
        }
    } else {
        diagnostics.push(`Contents 속성에서 관계 대상 DB ID를 확인할 수 없음`);
    }

    try {
        const res = await notion.search({
            query: keyword,
            filter: { property: 'object', value: 'page' },
            page_size: 20
        });
        const lower = keyword.toLowerCase();
        const match = res.results.find(p => {
            const key = Object.keys(p.properties || {}).find(k => p.properties[k].type === 'title');
            if (!key) return false;
            const text = (p.properties[key].title || []).map(t => t.plain_text).join('');
            return text.toLowerCase().includes(lower);
        });
        if (match) return { id: match.id, diagnostics };
        diagnostics.push(`워크스페이스 검색(위젯 통합에 공유된 페이지만 대상)에서도 "${keyword}" 포함 페이지를 찾지 못함`);
    } catch (e) {
        diagnostics.push(`워크스페이스 검색 실패: ${e.message}`);
    }

    return { id: null, diagnostics };
}

// dateISO(YYYY-MM-DD) ~ dateEndISO(포함) 사이의 모든 날짜를 나열한다 (여러날짜짜리 연휴 대응).
function datesInRange(startISO, endISO) {
    const dates = [];
    let d = DateTime.fromISO(startISO);
    const endDt = endISO ? DateTime.fromISO(endISO) : d;
    while (d <= endDt) {
        dates.push(d.toISODate());
        d = d.plus({ days: 1 });
    }
    return dates;
}

// Notion date/formula-date 속성에서 {start, end}(YYYY-MM-DD)를 안전하게 뽑는다. (cron.js와 동일)
function getSafeDateRange(prop) {
    if (!prop) return null;
    if (prop.type === 'date' && prop.date) {
        return { start: prop.date.start.substring(0, 10), end: (prop.date.end || prop.date.start).substring(0, 10) };
    }
    return null;
}

// Annual/Monthly/Weekly DB를 전부 불러와, 단일 날짜짜리 Schedule은 해당 주기(연/월/주)
// 전체로 넓혀서 겹치는 페이지를 찾는다. (cron.js의 findOverlappingIds와 동일한 로직 -
// 검증된 동일 방식을 그대로 재사용한다.)
async function loadAllPages(notion, dbId) {
    if (!dbId) return [];
    let allResults = []; let hasMore = true; let cursor = undefined;
    while (hasMore) {
        try {
            const res = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor });
            allResults = allResults.concat(res.results);
            hasMore = res.has_more; cursor = res.next_cursor;
        } catch (e) {
            hasMore = false;
        }
    }
    return allResults;
}

function findOverlappingIds(candidates, schedPropName, taskStart, taskEnd, kind) {
    const matchedIds = [];
    for (const p of candidates) {
        const d = getSafeDateRange(p.properties[schedPropName]);
        if (!d) continue;
        let pStart = d.start; let pEnd = d.end;
        if (pStart === pEnd) {
            if (kind === 'weekly') pEnd = DateTime.fromISO(pStart).plus({ days: 6 }).toISODate();
            else if (kind === 'monthly') pEnd = DateTime.fromISO(pStart).endOf('month').toISODate();
            else if (kind === 'annual') pEnd = DateTime.fromISO(pStart).endOf('year').toISODate();
        }
        if (taskStart <= pEnd && taskEnd >= pStart) matchedIds.push(p.id);
    }
    return matchedIds;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const { key, year } = req.query;
  if (!process.env.WIDGET_SECRET || key !== process.env.WIDGET_SECRET) {
      return res.status(401).json({ success: false, error: "⛔ 접근 권한이 없습니다." });
  }

  const targetYear = parseInt(year);
  if (!targetYear || targetYear < 2000 || targetYear > 2100) {
      return res.status(400).json({ success: false, error: "연도를 올바르게 지정해주세요." });
  }

  const { NOTION_TOKEN, PERSONAL_MASTER_DB_ID, DAILY_DB_ID, WEEKLY_DB_ID, MONTHLY_DB_ID, ANNUAL_DB_ID } = Config.ENV;
  if (!NOTION_TOKEN || !PERSONAL_MASTER_DB_ID) {
      return res.status(500).json({ success: false, error: "NOTION_TOKEN 또는 PERSONAL_MASTER_DB_ID 가 없습니다." });
  }

  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 60000, notionVersion: '2022-06-28' });
  const schedProp = Config.SCHEMA.SCHEDULE.name;

  try {
      const { items, verified, warnings } = await getYearItems(targetYear);
      const logs = [];
      if (!verified) {
          logs.push(`ℹ️ ${targetYear}년은 확인된 표가 없어 고정 날짜/24절기 + KASI API 조회 결과로 자동 생성했습니다.`);
      }
      warnings.forEach(w => logs.push(w));

      // 제목 속성 이름은 사용자가 "이름"/"Name" 등으로 바꿔뒀을 수 있으니,
      // 이름으로 고정하지 않고 실제 title 타입 속성을 찾아서 사용한다.
      const dbInfo = await notion.databases.retrieve({ database_id: PERSONAL_MASTER_DB_ID });
      const titleProp = Object.keys(dbInfo.properties).find(k => dbInfo.properties[k].type === 'title') || Config.SCHEMA.TITLE.name;

      const findProp = (schemaName) => Object.keys(dbInfo.properties).find(k =>
          dbInfo.properties[k].type === 'relation' && k.toLowerCase() === schemaName.toLowerCase()
      );
      const contentsProp = findProp(Config.SCHEMA.CONTENTS.name);
      const backupProp = findProp(Config.SCHEMA.BACKUP.name);
      const yearCheckProp = findProp(Config.SCHEMA.YEAR_CHECK.name);
      const monthCheckProp = findProp(Config.SCHEMA.MONTH_CHECK.name);
      const weekCheckProp = findProp(Config.SCHEMA.WEEK_CHECK.name);

      // Contents 관계형 속성(있다면)에, 제목에 "Holiday"가 포함된 태그 페이지를 찾아 연결한다.
      // 없으면 태그 연결 없이 계속 진행하되, 원인을 구체적으로 로그에 남긴다.
      let holidayTagId = null;
      if (contentsProp) {
          const tagResult = await findHolidayTagId(notion, dbInfo, contentsProp, CONTENTS_HOLIDAY_KEYWORD);
          holidayTagId = tagResult.id;
          if (!holidayTagId) {
              logs.push(`⚠️ Contents 연결용 "${CONTENTS_HOLIDAY_KEYWORD}" 페이지를 찾지 못해 Contents 연결 없이 생성합니다. (${tagResult.diagnostics.join(' / ')})`);
              logs.push(`💡 Notion에서 "Event & Holiday" 페이지(또는 그 상위 DB)를 열어 "..." → Connections에서 이 위젯의 통합이 연결되어 있는지 확인해보세요.`);
          }
      } else {
          logs.push(`ℹ️ "Contents" 관계형 속성을 찾을 수 없어 태그 연결 없이 생성합니다.`);
      }

      // Backup/Year Check/Month Check/Week Check에 쓸 Daily/Weekly/Monthly/Annual DB를
      // 한 번에 전부 불러온다 (cron.js의 메인 동기화 엔진과 동일한 겹침판정 방식 재사용).
      const yStart = `${targetYear}-01-01`; const yEnd = `${targetYear}-12-31`;
      const rangeFilter = (propName) => ({ and: [
          { property: propName, date: { on_or_after: yStart } },
          { property: propName, date: { on_or_before: yEnd } }
      ] });
      const loadRangedPages = async (dbId, propNameGuess) => {
          if (!dbId) return [];
          try {
              const info = await notion.databases.retrieve({ database_id: dbId });
              const prop = Object.keys(info.properties).find(k => k.toLowerCase() === propNameGuess.toLowerCase()) || propNameGuess;
              let allResults = []; let hasMore = true; let cursor = undefined;
              while (hasMore) {
                  const res = await notion.databases.query({ database_id: dbId, filter: rangeFilter(prop), start_cursor: cursor, page_size: 100 });
                  allResults = allResults.concat(res.results);
                  hasMore = res.has_more; cursor = res.next_cursor;
              }
              return { pages: allResults, schedPropName: prop };
          } catch (e) {
              logs.push(`⚠️ 참조 DB 조회 실패: ${e.message}`);
              return { pages: [], schedPropName: propNameGuess };
          }
      };

      // Annual DB는 연 1건뿐이라 row 수가 적어 날짜창 없이 전체를 그냥 로드한다 (cron.js와 동일한 이유).
      const loadAnnualPages = async (dbId, propNameGuess) => {
          if (!dbId) return { pages: [], schedPropName: propNameGuess };
          try {
              const info = await notion.databases.retrieve({ database_id: dbId });
              const prop = Object.keys(info.properties).find(k => k.toLowerCase() === propNameGuess.toLowerCase()) || propNameGuess;
              const pages = await loadAllPages(notion, dbId);
              return { pages, schedPropName: prop };
          } catch (e) {
              logs.push(`⚠️ Annual DB 조회 실패: ${e.message}`);
              return { pages: [], schedPropName: propNameGuess };
          }
      };

      const [dailyRes, weeklyRes, monthlyRes, annualRes] = await Promise.all([
          (backupProp && DAILY_DB_ID) ? loadRangedPages(DAILY_DB_ID, schedProp) : Promise.resolve({ pages: [], schedPropName: schedProp }),
          (weekCheckProp && WEEKLY_DB_ID) ? loadRangedPages(WEEKLY_DB_ID, schedProp) : Promise.resolve({ pages: [], schedPropName: schedProp }),
          (monthCheckProp && MONTHLY_DB_ID) ? loadRangedPages(MONTHLY_DB_ID, schedProp) : Promise.resolve({ pages: [], schedPropName: schedProp }),
          (yearCheckProp && ANNUAL_DB_ID) ? loadAnnualPages(ANNUAL_DB_ID, schedProp) : Promise.resolve({ pages: [], schedPropName: schedProp })
      ]);

      const dailyMap = new Map();
      dailyRes.pages.forEach(p => {
          const d = getSafeDateRange(p.properties[dailyRes.schedPropName]);
          if (d && d.start) dailyMap.set(d.start, p.id);
      });

      function resolveLinkIds(it) {
          const start = it.s; const end = it.e || it.s;
          const out = {};
          if (backupProp) {
              const ids = datesInRange(start, end).map(d => dailyMap.get(d)).filter(Boolean);
              if (ids.length > 0) out[backupProp] = ids;
          }
          if (weekCheckProp) {
              const ids = findOverlappingIds(weeklyRes.pages, weeklyRes.schedPropName, start, end, 'weekly');
              if (ids.length > 0) out[weekCheckProp] = ids;
          }
          if (monthCheckProp) {
              const ids = findOverlappingIds(monthlyRes.pages, monthlyRes.schedPropName, start, end, 'monthly');
              if (ids.length > 0) out[monthCheckProp] = ids;
          }
          if (yearCheckProp) {
              const ids = findOverlappingIds(annualRes.pages, annualRes.schedPropName, start, end, 'annual');
              if (ids.length > 0) out[yearCheckProp] = ids;
          }
          return out;
      }

      // 같은 해에 이미 만들어진 제목은 건너뛴다 (중복 방지). 각 관계 속성이 비어있는지도 같이 기록.
      const existingMap = new Map(); // title -> { id, empty: {propName: true/false} }
      const trackedProps = [contentsProp, backupProp, yearCheckProp, monthCheckProp, weekCheckProp].filter(Boolean);
      {
          let hasMore = true; let cursor = undefined;
          while (hasMore) {
              const resp = await notion.databases.query({
                  database_id: PERSONAL_MASTER_DB_ID,
                  filter: { and: [ { property: schedProp, date: { on_or_after: yStart } }, { property: schedProp, date: { on_or_before: yEnd } } ] },
                  start_cursor: cursor
              });
              resp.results.forEach(p => {
                  const t = extractTitle(p.properties);
                  if (!t) return;
                  const empty = {};
                  trackedProps.forEach(propName => {
                      const pv = p.properties[propName];
                      empty[propName] = !(pv && pv.relation && pv.relation.length > 0);
                  });
                  existingMap.set(t, { id: p.id, empty });
              });
              hasMore = resp.has_more; cursor = resp.next_cursor;
          }
      }

      const created = []; const skipped = []; const patched = [];
      for (let i = 0; i < items.length; i += 3) {
          const batch = items.slice(i, i + 3);
          await Promise.all(batch.map(async (it) => {
              const existing = existingMap.get(it.t);
              if (existing) {
                  skipped.push(it.t);
                  // 이미 있는 항목인데 관계 속성이 비어있으면 그것만 채워준다.
                  // 이미 뭔가 연결돼 있으면(직접 다르게 분류해둔 경우) 건드리지 않는다.
                  const patchProps = {};
                  if (contentsProp && holidayTagId && existing.empty[contentsProp]) {
                      patchProps[contentsProp] = { relation: [{ id: holidayTagId }] };
                  }
                  const linkIds = resolveLinkIds(it);
                  [backupProp, yearCheckProp, monthCheckProp, weekCheckProp].filter(Boolean).forEach(propName => {
                      if (existing.empty[propName] && linkIds[propName]) {
                          patchProps[propName] = { relation: linkIds[propName].map(id => ({ id })) };
                      }
                  });
                  if (Object.keys(patchProps).length > 0) {
                      try {
                          await notion.pages.update({ page_id: existing.id, properties: patchProps });
                          patched.push(it.t);
                      } catch (e) {
                          logs.push(`❌ ${it.t} 보정 실패: ${e.message}`);
                      }
                  }
                  return;
              }
              const properties = {
                  [titleProp]: { title: [{ text: { content: it.t } }] },
                  [schedProp]: { date: { start: it.s, end: it.e || null } }
              };
              if (it.cat === 'holiday') {
                  properties[Config.SCHEMA.NOTE.name] = { rich_text: holidayBadgeRichText() };
              }
              if (contentsProp && holidayTagId) {
                  properties[contentsProp] = { relation: [{ id: holidayTagId }] };
              }
              const linkIds = resolveLinkIds(it);
              Object.keys(linkIds).forEach(propName => {
                  properties[propName] = { relation: linkIds[propName].map(id => ({ id })) };
              });
              try {
                  await notion.pages.create({
                      parent: { database_id: PERSONAL_MASTER_DB_ID },
                      properties,
                      icon: iconFor(it.t, it.cat)
                  });
                  created.push(it.t);
              } catch (e) {
                  logs.push(`❌ ${it.t} 생성 실패: ${e.message}`);
              }
          }));
          await new Promise(r => setTimeout(r, 200));
      }

      logs.push(`생성 ${created.length}개 / 건너뜀(이미 있음) ${skipped.length}개 / Contents·Backup·Year·Month·Week Check 보정 ${patched.length}개`);
      res.status(200).json({ success: true, message: `${targetYear}년: 생성 ${created.length} / 스킵 ${skipped.length} / 보정 ${patched.length}`, logs, created, skipped, patched, verified });
  } catch (err) {
      res.status(500).json({ success: false, error: err.message });
  }
};
