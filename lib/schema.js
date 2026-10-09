// lib/schema.js
// 위젯이 "이름으로" 찾아 쓰는 노션 속성과, 사용자의 DB가 그 이름과 맞는지 점검하는 로직.
//  - 구버전 템플릿 사용자는 속성명이 달라 연결이 조용히 건너뛰어지는 경우가 많다.
//    (cron / generate 는 속성이 없으면 에러 없이 그 연결만 생략한다)
//  - 이 모듈은 "읽기 전용 진단"만 한다. 사용자의 DB를 수정하지 않는다.
// 기준: 2027 Huinaology 템플릿의 실제 속성명 (Title은 title 타입을 찾아 쓰므로 이름 무관 → 점검 제외).

// role → 환경변수/라벨/속성 목록
//  need   : 'required'(없으면 해당 연결 기능이 동작하지 않음) | 'optional'(없어도 핵심 기능은 동작)
//  to     : relation이 가리켜야 할 DB의 role ('self' = 자기 자신)
//  aliases: 구버전에서 쓰였을 법한 이름 (추정용. 일치하면 "이 속성 아닐까요?" 하고 제안만 한다)
const ROLES = {
    daily: {
        label: 'Daily Archive', env: 'DAILY_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'self', need: 'required', why: '자기 자신을 연결합니다 (Generator 연결 단계)', aliases: ['Back up', 'Back-up', '백업', 'Self'] },
            { name: 'Month Check', type: 'relation', to: 'monthly', need: 'required', why: '해당 날짜의 Monthly 페이지 연결', aliases: ['Month', 'Monthly', '월', '월간'] },
            { name: 'Week Check', type: 'relation', to: 'weekly', need: 'required', why: '해당 날짜의 Weekly 페이지 연결', aliases: ['Week', 'Weekly', '주', '주간'] },
            { name: 'Year', type: 'relation', to: 'annual', need: 'required', why: '해당 연도의 Annual 페이지 연결', aliases: ['Year Check', 'Annual', '연도', '년도'] },
            { name: 'Note', type: 'rich_text', need: 'optional', why: '자동실행이 반복 실패할 때 실패 뱃지를 남기는 칸', aliases: ['Notes', '메모'] },
        ],
    },
    weekly: {
        label: 'Weekly Archive', env: 'WEEKLY_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Week Check', type: 'relation', to: 'self', need: 'required', why: '자기 자신을 연결합니다', aliases: ['Week', 'Self', 'Weekly'] },
            { name: 'Last Week', type: 'relation', to: 'self', need: 'required', why: '이전 주 연결', aliases: ['Last', 'Prev', 'Previous', 'Prev Week', '지난주', '전주', '이전', '이전 주'] },
            { name: 'Next Week', type: 'relation', to: 'self', need: 'required', why: '다음 주 연결', aliases: ['Next', '다음주', '차주', '다음', '다음 주'] },
            { name: 'Month Check', type: 'relation', to: 'monthly', need: 'required', why: '해당 주의 Monthly 연결', aliases: ['Month', 'Monthly', '월', '월간'] },
            { name: 'Year', type: 'relation', to: 'annual', need: 'required', why: '해당 연도의 Annual 연결', aliases: ['Year Check', 'Annual', '연도', '년도'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'optional', why: '이 주에 포함된 Daily 모아보기 (템플릿 기능)', aliases: ['Daily', 'Back up', '백업'] },
        ],
    },
    monthly: {
        label: 'Monthly Archive', env: 'MONTHLY_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Month Check', type: 'relation', to: 'self', need: 'required', why: '자기 자신을 연결합니다', aliases: ['Month', 'Self', 'Monthly'] },
            { name: 'Last Month', type: 'relation', to: 'self', need: 'required', why: '이전 달 연결', aliases: ['Last', 'Prev', 'Previous', 'Prev Month', '지난달', '전월', '이전', '이전 달'] },
            { name: 'Next Month', type: 'relation', to: 'self', need: 'required', why: '다음 달 연결', aliases: ['Next', '다음달', '익월', '다음', '다음 달'] },
            { name: 'Year', type: 'relation', to: 'annual', need: 'required', why: '해당 연도의 Annual 연결', aliases: ['Year Check', 'Annual', '연도', '년도'] },
            { name: 'Week Check', type: 'relation', to: 'weekly', need: 'optional', why: '이 달에 포함된 Weekly 모아보기 (템플릿 기능)', aliases: ['Week', 'Weekly', '주'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'optional', why: '이 달에 포함된 Daily 모아보기 (템플릿 기능)', aliases: ['Daily', 'Back up', '백업'] },
        ],
    },
    annual: {
        label: 'Annual Archive', env: 'ANNUAL_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '연도 범위로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
        ],
    },
    finWeekly: {
        label: 'Finance Weekly Archive', env: 'FIN_WEEKLY_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Week Check', type: 'relation', to: 'self', need: 'required', why: '자기 자신을 연결합니다', aliases: ['Week', 'Self', 'Weekly'] },
            { name: 'Last Week', type: 'relation', to: 'self', need: 'required', why: '이전 주 연결', aliases: ['Last', 'Prev', 'Previous', 'Prev Week', '지난주', '전주', '이전', '이전 주'] },
            { name: 'Next Week', type: 'relation', to: 'self', need: 'required', why: '다음 주 연결', aliases: ['Next', '다음주', '차주', '다음', '다음 주'] },
            { name: 'Month Check', type: 'relation', to: 'finMonthly', need: 'required', why: '해당 주의 Finance Monthly 연결', aliases: ['Month', 'Monthly', '월', '월간'] },
            { name: 'Week Backup', type: 'relation', to: 'weekly', need: 'required', why: '같은 주의 일반 Weekly 연결', aliases: ['Weekly Backup', 'Week', '주 백업'] },
            { name: 'Month Backup', type: 'relation', to: 'monthly', need: 'required', why: '같은 달의 일반 Monthly 연결', aliases: ['Monthly Backup', 'Month', '월 백업'] },
            { name: 'Year', type: 'relation', to: 'annual', need: 'required', why: '해당 연도의 Annual 연결', aliases: ['Year Check', 'Annual', '연도', '년도'] },
        ],
    },
    finMonthly: {
        label: 'Finance Monthly Archive', env: 'FIN_MONTHLY_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜로 페이지를 찾는 기준입니다', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Month Check', type: 'relation', to: 'self', need: 'required', why: '자기 자신을 연결합니다', aliases: ['Month', 'Self', 'Monthly'] },
            { name: 'Last Month', type: 'relation', to: 'self', need: 'required', why: '이전 달 연결', aliases: ['Last', 'Prev', 'Previous', 'Prev Month', '지난달', '전월', '이전', '이전 달'] },
            { name: 'Next Month', type: 'relation', to: 'self', need: 'required', why: '다음 달 연결', aliases: ['Next', '다음달', '익월', '다음', '다음 달'] },
            { name: 'Month Backup', type: 'relation', to: 'monthly', need: 'required', why: '같은 달의 일반 Monthly 연결', aliases: ['Monthly Backup', 'Month', '월 백업'] },
            { name: 'Year', type: 'relation', to: 'annual', need: 'required', why: '해당 연도의 Annual 연결', aliases: ['Year Check', 'Annual', '연도', '년도'] },
        ],
    },
    personalMaster: {
        label: 'Personal Master', env: 'PERSONAL_MASTER_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '일정 날짜 (자동 연결의 기준)', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'required', why: '일정이 걸친 날짜의 Daily 연결', aliases: ['Daily', 'Back up', 'Back-up', '백업'] },
            { name: 'Week Check', type: 'relation', to: 'weekly', need: 'required', why: '일정의 Weekly 연결', aliases: ['Week', 'Weekly', '주'] },
            { name: 'Month Check', type: 'relation', to: 'monthly', need: 'required', why: '일정의 Monthly 연결', aliases: ['Month', 'Monthly', '월'] },
            { name: 'Year Check', type: 'relation', to: 'annual', need: 'required', why: '일정의 Annual 연결', aliases: ['Year', 'Annual', '연도', '년도'] },
            { name: 'Self Backup', type: 'relation', to: 'self', need: 'optional', why: '자기 자신 연결 (누락 보정용)', aliases: ['Self', 'Self-Backup', '자가 백업'] },
            { name: 'Final Update', type: 'date', need: 'optional', why: '완료일 기준 기간 계산 (없으면 Schedule만 사용)', aliases: ['Final', 'Updated', '완료일'] },
            { name: '⏲️ipr Calendar', type: 'formula', need: 'optional', why: '진행중(ipr) 일정의 기간 계산 (없으면 Schedule만 사용)', aliases: ['ipr Calendar', 'ipr'] },
            { name: 'Contents', type: 'relation', need: 'optional', why: 'Holiday Generator가 "Holiday" 태그를 연결하는 칸', aliases: ['Content', '컨텐츠', '콘텐츠'] },
            { name: 'Note', type: 'rich_text', need: 'optional', why: '실패 뱃지 / Holiday 뱃지를 남기는 칸', aliases: ['Notes', '메모'] },
        ],
    },
    financeMaster: {
        label: 'Finance Master', env: 'FINANCE_MASTER_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '입지출 날짜 (자동 연결의 기준)', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'required', why: '입지출 날짜의 Daily 연결', aliases: ['Daily', 'Back up', 'Back-up', '백업'] },
            { name: 'Week Backup', type: 'relation', to: 'weekly', need: 'required', why: '일반 Weekly 연결', aliases: ['Weekly Backup', '주 백업'] },
            { name: 'Month Backup', type: 'relation', to: 'monthly', need: 'required', why: '일반 Monthly 연결', aliases: ['Monthly Backup', '월 백업'] },
            { name: 'Week Check', type: 'relation', to: 'finWeekly', need: 'required', why: 'Finance Weekly 연결 (금액 합산 기준)', aliases: ['Week', 'Weekly', '주'] },
            { name: 'Month Check', type: 'relation', to: 'finMonthly', need: 'required', why: 'Finance Monthly 연결 (금액 합산 기준)', aliases: ['Month', 'Monthly', '월'] },
            { name: 'Year Check', type: 'relation', to: 'annual', need: 'required', why: 'Annual 연결', aliases: ['Year', 'Annual', '연도', '년도'] },
            { name: 'Self Backup', type: 'relation', to: 'self', need: 'optional', why: '자기 자신 연결 (누락 보정용)', aliases: ['Self', 'Self-Backup', '자가 백업'] },
            { name: 'Final Update', type: 'date', need: 'optional', why: '완료일 기준 기간 계산', aliases: ['Final', 'Updated', '완료일'] },
        ],
    },
    mediaMaster: {
        label: 'Media Master', env: 'MEDIA_MASTER_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '기록 날짜 (자동 연결의 기준)', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'required', why: '기록 날짜의 Daily 연결', aliases: ['Daily', 'Back up', 'Back-up', '백업'] },
            { name: 'Week Check', type: 'relation', to: 'weekly', need: 'required', why: 'Weekly 연결', aliases: ['Week', 'Weekly', '주'] },
            { name: 'Month Check', type: 'relation', to: 'monthly', need: 'required', why: 'Monthly 연결', aliases: ['Month', 'Monthly', '월'] },
            { name: 'Year Check', type: 'relation', to: 'annual', need: 'required', why: 'Annual 연결', aliases: ['Year', 'Annual', '연도', '년도'] },
            { name: 'Self Backup', type: 'relation', to: 'self', need: 'optional', why: '자기 자신 연결 (누락 보정용)', aliases: ['Self', 'Self-Backup', '자가 백업'] },
            { name: 'Final Update', type: 'date', need: 'optional', why: '완료일 기준 기간 계산', aliases: ['Final', 'Updated', '완료일'] },
            { name: '⏲️ipr Calendar', type: 'formula', need: 'optional', why: '진행중(ipr) 일정의 기간 계산', aliases: ['ipr Calendar', 'ipr'] },
        ],
    },
    timeline: {
        label: 'Time Table (Timeline)', env: 'TIMELINE_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '시간대(정시~정시+1시간) 기준', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'required', why: '그 날짜의 Daily 연결', aliases: ['Daily', 'Back up', 'Back-up', '백업'] },
        ],
    },
    pomodoro: {
        label: 'Pomodoro', env: 'POMODORO_DB_ID',
        props: [
            { name: 'Schedule', type: 'date', need: 'required', why: '날짜 기준', aliases: ['Date', '날짜', '일정', '기간'] },
            { name: 'Backup', type: 'relation', to: 'daily', need: 'required', why: '그 날짜의 Daily 연결', aliases: ['Daily', 'Back up', 'Back-up', '백업'] },
        ],
    },
};

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const idKey = (id) => String(id || '').replace(/-/g, '').toLowerCase();

function similarity(a, b) {
    // 레벤슈타인 기반 0~1 유사도
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return 1 - dp[m][n] / Math.max(m, n);
}

// 하나의 DB(role)를 점검한다.
//   props : notion.databases.retrieve().properties
//   ownId : 이 DB의 ID,  roleIds: { role: 정규화된 DB ID }  (환경변수로 지정된 DB들)
function analyzeDb(roleKey, props, ownId, roleIds) {
    const role = ROLES[roleKey];
    const names = Object.keys(props);
    const targetOf = (spec) => {
        if (!spec.to) return null;
        return spec.to === 'self' ? idKey(ownId) : (roleIds[spec.to] || null);
    };
    const relTarget = (p) => idKey(p?.relation?.database_id);

    const items = new Array(role.props.length);
    const exactNames = new Set(role.props.map(s => s.name));
    const claimed = new Set();           // 이미 어떤 항목에 배정된 실제 속성명
    const pending = [];                  // 이름이 정확히 일치하지 않은 항목 인덱스

    role.props.forEach((spec, idx) => {
        const actual = props[spec.name];
        if (actual) {
            claimed.add(spec.name);
            if (actual.type !== spec.type) {
                items[idx] = { name: spec.name, level: 'type', need: spec.need, why: spec.why,
                    message: `이름은 맞지만 속성 종류가 다릅니다. (현재: ${actual.type} / 필요: ${spec.type})` };
                return;
            }
            const want = targetOf(spec);
            if (spec.type === 'relation' && want && relTarget(actual) && relTarget(actual) !== want) {
                const toText = spec.to === 'self' ? '이 DB 자기 자신' : `${ROLES[spec.to].label}(${ROLES[spec.to].env})`;
                items[idx] = { name: spec.name, level: 'target', need: spec.need, why: spec.why,
                    message: `이름은 맞지만 연결된 DB가 다릅니다. ${toText}를 가리켜야 합니다. (다른 DB를 가리키거나, 템플릿을 복제하면서 연결이 어긋났을 수 있어요)` };
                return;
            }
            items[idx] = { name: spec.name, level: 'ok', need: spec.need, why: spec.why };
            return;
        }
        pending.push(idx);
    });

    // 1) 대소문자·공백·기호만 다른 경우 → "이름만 정확히 바꾸면 되는" 가장 흔한 케이스
    const stillMissing = [];
    for (const idx of pending) {
        const spec = role.props[idx];
        const hit = names.find(n => !claimed.has(n) && !exactNames.has(n) && norm(n) === norm(spec.name) && props[n].type === spec.type);
        if (hit) {
            claimed.add(hit);
            items[idx] = { name: spec.name, level: 'rename', need: spec.need, why: spec.why, found: hit,
                message: `"${hit}" 라는 이름으로 있습니다. 위젯은 대소문자·띄어쓰기까지 정확히 같은 "${spec.name}" 이름만 인식합니다.` };
        } else stillMissing.push(idx);
    }

    // 2) 이름이 많이 다른 경우 → 종류(type)·연결 대상·이름 유사도로 후보 제안 (제안만 하고 확정하지 않음)
    const pairs = [];
    for (const idx of stillMissing) {
        const spec = role.props[idx];
        const want = targetOf(spec);
        const aliasSet = new Set((spec.aliases || []).map(norm));
        names.forEach(n => {
            if (claimed.has(n) || exactNames.has(n)) return;
            const p = props[n];
            if (p.type !== spec.type) return;
            if (spec.type === 'relation' && want && relTarget(p) && relTarget(p) !== want) return;
            const nn = norm(n), sn = norm(spec.name);
            let score = 0, reason = '';
            if (aliasSet.has(nn)) { score = 90; reason = '구버전에서 흔히 쓰던 이름과 같습니다'; }
            else if (nn && (nn.includes(sn) || sn.includes(nn))) { score = 70; reason = '이름이 비슷합니다'; }
            else {
                const sim = Math.max(similarity(nn, sn), ...[...aliasSet].map(a => similarity(nn, a)));
                if (sim >= 0.6) { score = Math.round(sim * 60); reason = '이름이 비슷합니다'; }
            }
            if (score > 0) pairs.push({ idx, name: n, score, reason: `${reason}${spec.type === 'relation' && want ? ' · 연결 대상 DB도 일치' : ''}` });
        });
    }
    pairs.sort((a, b) => b.score - a.score);
    const suggested = {};          // idx → [{name, reason}]
    const usedForSuggest = new Set();
    pairs.forEach(p => {
        if (usedForSuggest.has(p.name)) return;
        (suggested[p.idx] = suggested[p.idx] || []);
        if (suggested[p.idx].length >= 1) return;
        suggested[p.idx].push({ name: p.name, reason: p.reason });
        usedForSuggest.add(p.name);
    });

    // 3) 마지막 보루: 같은 종류·같은 연결 대상 후보가 딱 하나뿐이고, 같은 조건을 기다리는 항목도 하나뿐이면 제안
    const sig = (spec) => `${spec.type}|${spec.type === 'relation' ? (targetOf(spec) || '?') : ''}`;
    const leftover = stillMissing.filter(idx => !suggested[idx]);
    leftover.forEach(idx => {
        const spec = role.props[idx];
        const sameWaiting = leftover.filter(j => sig(role.props[j]) === sig(spec)).length;
        if (sameWaiting !== 1) return;
        const cands = names.filter(n => !claimed.has(n) && !exactNames.has(n) && !usedForSuggest.has(n)
            && props[n].type === spec.type
            && (spec.type !== 'relation' || !targetOf(spec) || relTarget(props[n]) === targetOf(spec)));
        // 날짜/수식처럼 흔한 종류는 후보가 너무 많아 의미가 없으므로 relation만 대상으로 한다
        if (spec.type === 'relation' && cands.length === 1) {
            suggested[idx] = [{ name: cands[0], reason: '같은 대상 DB를 연결하는 유일한 속성입니다' }];
            usedForSuggest.add(cands[0]);
        }
    });

    stillMissing.forEach(idx => {
        const spec = role.props[idx];
        items[idx] = {
            name: spec.name, level: spec.need === 'required' ? 'missing' : 'optional-missing', need: spec.need, why: spec.why,
            suggest: suggested[idx] || [],
            message: spec.need === 'required'
                ? `"${spec.name}" 속성이 없습니다. 이 속성이 없으면 ${spec.why} 기능이 건너뛰어집니다.`
                : `"${spec.name}" 속성이 없습니다. (선택 사항: ${spec.why})`,
        };
    });

    const problems = items.filter(i => i.level !== 'ok');
    const hasBlocking = problems.some(i => i.need === 'required' && i.level !== 'optional-missing');
    const hasWarn = problems.some(i => i.level === 'optional-missing' || (i.need === 'optional' && i.level !== 'ok'));
    return {
        role: roleKey, label: role.label, envKey: role.env,
        status: hasBlocking ? 'error' : (hasWarn ? 'warn' : 'ok'),
        okCount: items.length - problems.length, total: items.length,
        items,
    };
}

module.exports = { ROLES, analyzeDb, idKey, norm };
