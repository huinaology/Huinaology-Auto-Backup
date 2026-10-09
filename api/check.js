const { Client } = require('@notionhq/client');
const { ROLES, analyzeDb, idKey } = require('../lib/schema');

// 속성명 점검 (읽기 전용): 환경변수에 등록된 DB들의 속성 이름·종류·연결 대상이
// 위젯이 기대하는 이름과 맞는지 확인한다. DB를 수정하지 않는다.
async function runSchemaCheck(notion) {
    const roleKeys = Object.keys(ROLES);
    const fetched = await Promise.all(roleKeys.map(async (roleKey) => {
        const envId = (process.env[ROLES[roleKey].env] || '').trim();
        if (!envId) return { roleKey, skipped: true };
        try {
            const db = await notion.databases.retrieve({ database_id: envId });
            return { roleKey, db };
        } catch (error) {
            let message = error.message || '';
            if (error.code === 'object_not_found') message = 'DB ID가 틀렸거나, 노션 [연결(Connections)]이 누락되었습니다.';
            else if (error.code === 'unauthorized') message = '토큰 값이 잘못되었습니다.';
            return { roleKey, failed: message };
        }
    }));

    // 다른 DB를 가리키는 relation인지 비교하려면, 실제로 조회된 DB의 ID가 필요하다.
    const roleIds = {};
    fetched.forEach(f => { if (f.db) roleIds[f.roleKey] = idKey(f.db.id); });

    const dbs = fetched.map(f => {
        const base = { role: f.roleKey, label: ROLES[f.roleKey].label, envKey: ROLES[f.roleKey].env };
        if (f.skipped) return { ...base, status: 'skipped', message: '➖ 미사용 (ID 비어있음 - 점검 생략)' };
        if (f.failed) return { ...base, status: 'fail', message: `❌ DB를 열 수 없어 점검하지 못했습니다 (${f.failed})` };
        return analyzeDb(f.roleKey, f.db.properties, f.db.id, roleIds);
    });

    const count = (s) => dbs.filter(d => d.status === s).length;
    const checked = dbs.filter(d => d.status === 'ok' || d.status === 'warn' || d.status === 'error').length;
    return {
        success: count('error') === 0 && count('fail') === 0 && checked > 0,
        checked,
        summary: { ok: count('ok'), warn: count('warn'), error: count('error'), fail: count('fail'), skipped: count('skipped') },
        dbs,
        message: checked === 0 ? '⚠️ 하나 이상의 DB ID를 입력해야 점검할 수 있습니다.' : undefined,
    };
}

export default async function handler(req, res) {
    const token = process.env.NOTION_TOKEN;

    if (!token) {
        return res.status(200).json({
            success: false,
            message: '🚨 [설정 오류] Vercel에 NOTION_TOKEN 환경 변수가 입력되지 않았습니다.'
        });
    }

    const notion = new Client({ auth: token, notionVersion: '2022-06-28' });

    if (req.query && req.query.mode === 'schema') {
        // 속성 이름을 보여주는 기능이라 다른 실행 기능과 같이 비밀번호(key)를 요구한다.
        if (!process.env.WIDGET_SECRET || req.query.key !== process.env.WIDGET_SECRET) {
            return res.status(401).json({ success: false, error: '⛔ 접근 권한이 없습니다.' });
        }
        try {
            return res.status(200).json(await runSchemaCheck(notion));
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    const dbKeys = [
        'ANNUAL_DB_ID', 'DAILY_DB_ID', 'FIN_MONTHLY_DB_ID', 'FIN_WEEKLY_DB_ID',
        'FINANCE_MASTER_DB_ID', 'MEDIA_MASTER_DB_ID', 'MONTHLY_DB_ID',
        'PERSONAL_MASTER_DB_ID', 'WEEKLY_DB_ID', 'TIMELINE_DB_ID', 'POMODORO_DB_ID', 'SYNC_STATE_DB_ID'
    ];

    let results = [];
    let hasError = false;
    let checkedCount = 0;

    for (const key of dbKeys) {
        const dbId = process.env[key];
        
        if (!dbId || dbId.trim() === '') {
            results.push({ 
                name: key, 
                status: 'missing', 
                message: '➖ 미사용 (ID 비어있음 - 스킵됨)' 
            });
            continue;
        }

        checkedCount++;
        try {
            await notion.databases.retrieve({ database_id: dbId });
            results.push({ name: key, status: 'ok', message: '✅ 연결 정상' });
        } catch (error) {
            hasError = true;
            let errorDesc = error.message || '';
            
            if (error.code === 'unauthorized' || errorDesc.includes('API token is invalid')) {
                errorDesc = '토큰 값이 잘못되었거나 형식이 올바르지 않습니다.';
            } else if (error.code === 'object_not_found' || errorDesc.includes('Could not find database')) {
                errorDesc = 'DB ID가 틀렸거나, 노션 페이지 우측 상단 [...]에서 [연결(Connections)]이 누락되었습니다.';
            }
            results.push({ name: key, status: 'error', message: `❌ 실패 (${errorDesc})` });
        }
    }

    // 검사한 DB가 하나도 없으면 에러로 간주
    if (checkedCount === 0) {
        return res.status(200).json({ 
            success: false, 
            details: results,
            message: '⚠️ 하나 이상의 DB ID를 입력해야 합니다.' 
        });
    }

    res.status(200).json({ success: !hasError, details: results });
}