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
//     2) YEAR_DATA에 없는 연도는 아래 computeYear()가 "고정일(양력) + 24절기"
//        만 자동으로 계산해서 채웁니다. 설날/추석/부처님오신날(음력 3종)은
//        표에 없으면 절대 자동으로 만들지 않고, 안내 로그만 남깁니다.
//        즉, 새해가 오면 YEAR_DATA에 그 해의 음력 3종 날짜를 추가해줘야
//        자동 생성 대상에 포함됩니다. (구매처 업데이트 안내를 통해 매년
//        갱신된 코드를 배포할 예정입니다.)
//
//   [더 정확한 음력 데이터 연결을 원한다면]
//   한국천문연구원이 공공데이터포털을 통해 제공하는 "특일 정보" 오픈API를
//   신청해서 연동하면, 음력↔양력 변환과 공휴일 정보를 매년 직접 입력하지
//   않아도 API 응답 기준으로 정확하게 가져올 수 있습니다.
//     - 신청/설명 페이지: https://www.data.go.kr/data/15012690/openapi.do
//     - 공공데이터포털(data.go.kr) 로그인 → 위 페이지에서 "활용신청" →
//       발급된 인증키로 getRestDeInfo(공휴일)/getLunCalInfo(음력변환) 등의
//       오퍼레이션을 호출하는 방식입니다.
//   ※ 이 위젯은 현재 이 API를 직접 호출하지 않고, 아래 YEAR_DATA 표를
//     수동으로 갱신하는 방식으로만 동작합니다. API 연동은 별도 신청/개발이
//     필요한 선택 사항입니다.
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

// 표에 없는 연도: 고정 항목 + 24절기만 자동 계산 (음력 3종은 생성하지 않음)
function computeYear(year) {
    const items = [];
    const usedDates = new Set();

    FIXED_ITEMS.forEach(f => {
        const dt = DateTime.fromISO(`${year}-${f.md}`);
        usedDates.add(dt.toISODate());
        items.push({ t: f.t, s: dt.toISODate(), cat: f.cat, _dt: dt });
    });

    items.forEach(it => {
        if (!SUB_HOLIDAY_ELIGIBLE.has(it.t)) return;
        if (it._dt.weekday !== 6 && it._dt.weekday !== 7) return;
        const sub = nextFreeWeekday(it._dt.plus({ days: 1 }), usedDates);
        usedDates.add(sub.toISODate());
        it.e = sub.toISODate();
    });
    items.forEach(it => delete it._dt);

    TERM_ITEMS.forEach(term => {
        items.push({ t: term.t, s: `${year}-${term.md}`, cat: 'term' });
    });

    return items;
}

function getYearItems(year) {
    if (YEAR_DATA[year]) return { items: YEAR_DATA[year], verified: true };
    return { items: computeYear(year), verified: false };
}

const extractTitle = (properties) => {
    if (!properties) return '';
    const key = Object.keys(properties).find(k => properties[k].type === 'title');
    if (!key || !properties[key].title || properties[key].title.length === 0) return '';
    return properties[key].title.map(t => t.plain_text).join('');
};

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

  const { NOTION_TOKEN, PERSONAL_MASTER_DB_ID } = Config.ENV;
  if (!NOTION_TOKEN || !PERSONAL_MASTER_DB_ID) {
      return res.status(500).json({ success: false, error: "NOTION_TOKEN 또는 PERSONAL_MASTER_DB_ID 가 없습니다." });
  }

  const notion = new Client({ auth: NOTION_TOKEN, timeoutMs: 60000, notionVersion: '2022-06-28' });
  const schedProp = Config.SCHEMA.SCHEDULE.name;

  try {
      const { items, verified } = getYearItems(targetYear);
      const logs = [];
      if (!verified) {
          logs.push(`⚠️ ${targetYear}년은 확인된 표가 없어 고정 날짜/24절기만 자동 생성했습니다. 설날·추석·부처님오신날(음력)은 정확한 날짜를 알려주시면 추가하겠습니다.`);
      }

      // 제목 속성 이름은 사용자가 "이름"/"Name" 등으로 바꿔뒀을 수 있으니,
      // 이름으로 고정하지 않고 실제 title 타입 속성을 찾아서 사용한다.
      const dbInfo = await notion.databases.retrieve({ database_id: PERSONAL_MASTER_DB_ID });
      const titleProp = Object.keys(dbInfo.properties).find(k => dbInfo.properties[k].type === 'title') || Config.SCHEMA.TITLE.name;

      // 같은 해에 이미 만들어진 제목은 건너뛴다 (중복 방지)
      const existingTitles = new Set();
      {
          const yStart = `${targetYear}-01-01`; const yEnd = `${targetYear}-12-31`;
          let hasMore = true; let cursor = undefined;
          while (hasMore) {
              const resp = await notion.databases.query({
                  database_id: PERSONAL_MASTER_DB_ID,
                  filter: { and: [ { property: schedProp, date: { on_or_after: yStart } }, { property: schedProp, date: { on_or_before: yEnd } } ] },
                  start_cursor: cursor
              });
              resp.results.forEach(p => {
                  const t = extractTitle(p.properties);
                  if (t) existingTitles.add(t);
              });
              hasMore = resp.has_more; cursor = resp.next_cursor;
          }
      }

      const created = []; const skipped = [];
      for (let i = 0; i < items.length; i += 3) {
          const batch = items.slice(i, i + 3);
          await Promise.all(batch.map(async (it) => {
              if (existingTitles.has(it.t)) { skipped.push(it.t); return; }
              const properties = {
                  [titleProp]: { title: [{ text: { content: it.t } }] },
                  [schedProp]: { date: { start: it.s, end: it.e || null } }
              };
              if (it.cat === 'holiday') {
                  properties[Config.SCHEMA.NOTE.name] = { rich_text: holidayBadgeRichText() };
              }
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

      logs.push(`생성 ${created.length}개 / 건너뜀(이미 있음) ${skipped.length}개`);
      res.status(200).json({ success: true, message: `${targetYear}년: 생성 ${created.length} / 스킵 ${skipped.length}`, logs, created, skipped, verified });
  } catch (err) {
      res.status(500).json({ success: false, error: err.message });
  }
};
