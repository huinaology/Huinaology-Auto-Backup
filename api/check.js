const { Client } = require('@notionhq/client');

export default async function handler(req, res) {
    const token = process.env.NOTION_TOKEN;
    
    // 1. 토큰 자체가 아예 입력되지 않은 경우
    if (!token) {
        return res.status(200).json({ 
            success: false, 
            message: '🚨 [설정 오류] Vercel에 NOTION_TOKEN 환경 변수가 입력되지 않았습니다.' 
        });
    }

    const notion = new Client({ auth: token });

    // 검사할 10개의 핵심 데이터베이스 키 리스트
    const dbKeys = [
        'ANNUAL_DB_ID', 'DAILY_DB_ID', 'FIN_MONTHLY_DB_ID', 'FIN_WEEKLY_DB_ID',
        'FINANCE_MASTER_DB_ID', 'MEDIA_MASTER_DB_ID', 'MONTHLY_DB_ID',
        'PERSONAL_MASTER_DB_ID', 'WEEKLY_DB_ID', 'TIMELINE_DB_ID'
    ];

    let results = [];
    let allPass = true;

    for (const key of dbKeys) {
        const dbId = process.env[key];
        
        // 2. 특정 DB ID 환경 변수가 비어있는 경우
        if (!dbId) {
            results.push({ 
                name: key, 
                status: 'missing', 
                message: '⚠️ [누락] Vercel 환경 변수에 해당 DB ID가 등록되지 않았습니다.' 
            });
            allPass = false;
            continue;
        }

        try {
            // 3. 노션 API를 통해 실제로 접근 가능한지 테스트
            await notion.databases.retrieve({ database_id: dbId });
            results.push({ 
                name: key, 
                status: 'ok', 
                message: '✅ 연결 정상' 
            });
        } catch (error) {
            allPass = false;
            let errorDesc = error.message || '';
            
            // 구매자들이 알기 쉽도록 에러 유형별 맞춤 안내 메시지 변환
            if (error.code === 'unauthorized' || errorDesc.includes('API token is invalid')) {
                errorDesc = '토큰 값이 잘못되었거나 형식이 올바르지 않습니다.';
            } else if (error.code === 'object_not_found' || errorDesc.includes('Could not find database')) {
                errorDesc = 'DB ID가 틀렸거나, 노션 페이지 우측 상단 [...]에서 [연결(Connections)]이 누락되었습니다.';
            }

            results.push({ 
                name: key, 
                status: 'error', 
                message: `❌ 실패 (${errorDesc})` 
            });
        }
    }

    res.status(200).json({ success: allPass, details: results });
}