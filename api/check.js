const { Client } = require('@notionhq/client');

export default async function handler(req, res) {
    // 1. 노션 클라이언트 초기화
    const token = process.env.NOTION_TOKEN;
    if (!token) {
        return res.status(200).json({ success: false, message: 'NOTION_TOKEN이 없습니다.' });
    }
    const notion = new Client({ auth: token });

    // 2. 검사할 DB 환경변수 목록
    const dbKeys = [
        'ANNUAL_DB_ID', 'DAILY_DB_ID', 'FIN_MONTHLY_DB_ID', 'FIN_WEEKLY_DB_ID',
        'FINANCE_MASTER_DB_ID', 'MEDIA_MASTER_DB_ID', 'MONTHLY_DB_ID',
        'PERSONAL_MASTER_DB_ID', 'WEEKLY_DB_ID', 'TIMELINE_DB_ID' // 타임라인 DB 추가
    ];

    let results = [];
    let allPass = true;

    // 3. 각 DB별로 조회(Retrieve) 테스트 진행
    for (const key of dbKeys) {
        const dbId = process.env[key];
        if (!dbId) {
            results.push({ name: key, status: 'missing', message: '환경 변수 누락' });
            allPass = false;
            continue;
        }
        try {
            // 노션 API로 해당 DB 접근 시도
            await notion.databases.retrieve({ database_id: dbId });
            results.push({ name: key, status: 'ok', message: '✅ 연결 정상' });
        } catch (error) {
            results.push({ name: key, status: 'error', message: '❌ 접근 불가 (권한/ID 확인)' });
            allPass = false;
        }
    }

    res.status(200).json({ success: allPass, details: results });
}