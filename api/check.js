const { Client } = require('@notionhq/client');

export default async function handler(req, res) {
    const token = process.env.NOTION_TOKEN;
    
    if (!token) {
        return res.status(200).json({ 
            success: false, 
            message: '🚨 [설정 오류] Vercel에 NOTION_TOKEN 환경 변수가 입력되지 않았습니다.' 
        });
    }

    const notion = new Client({ auth: token });
    const dbKeys = [
        'ANNUAL_DB_ID', 'DAILY_DB_ID', 'FIN_MONTHLY_DB_ID', 'FIN_WEEKLY_DB_ID',
        'FINANCE_MASTER_DB_ID', 'MEDIA_MASTER_DB_ID', 'MONTHLY_DB_ID',
        'PERSONAL_MASTER_DB_ID', 'WEEKLY_DB_ID', 'TIMELINE_DB_ID'
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