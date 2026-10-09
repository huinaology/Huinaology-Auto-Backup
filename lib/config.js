// lib/config.js
// Huinaology Auto-Backup (Public) 전용 설정.
// 개인용(Tsukiuta/Game 등) DB는 존재하지 않으므로 아예 정의하지 않는다.
const Config = {
    // 1. 환경 변수 (DB ID) 매핑
    ENV: {
        NOTION_TOKEN: process.env.NOTION_TOKEN,
        DAILY_DB_ID: process.env.DAILY_DB_ID,
        WEEKLY_DB_ID: process.env.WEEKLY_DB_ID,
        MONTHLY_DB_ID: process.env.MONTHLY_DB_ID,
        ANNUAL_DB_ID: process.env.ANNUAL_DB_ID,
        TIMELINE_DB_ID: process.env.TIMELINE_DB_ID,
        POMODORO_DB_ID: process.env.POMODORO_DB_ID,
        PERSONAL_MASTER_DB_ID: process.env.PERSONAL_MASTER_DB_ID,
        FINANCE_MASTER_DB_ID: process.env.FINANCE_MASTER_DB_ID,
        MEDIA_MASTER_DB_ID: process.env.MEDIA_MASTER_DB_ID,
        FIN_WEEKLY_DB_ID: process.env.FIN_WEEKLY_DB_ID,
        FIN_MONTHLY_DB_ID: process.env.FIN_MONTHLY_DB_ID,
        // 선택 사항: 한국천문연구원 "특일 정보" 오픈API 인증키. 설정하면 설날/추석/
        // 부처님오신날(음력) 날짜를 매년 자동으로 정확하게 채운다. 미설정 시 고정
        // 날짜/24절기만 자동 생성되고, 음력 3종은 YEAR_DATA 표에 수동 입력이 필요하다.
        KASI_API_KEY: process.env.KASI_API_KEY,
    },

    // 2. 노션 속성(Property) 스키마 매핑 (Public 템플릿 기준 속성명)
    SCHEMA: {
        SCHEDULE: { name: 'Schedule', type: 'date' },
        FINAL_UPDATE: { name: 'Final Update', type: 'date' },
        IPR_CALENDAR: { name: '⏲️ipr Calendar', type: 'formula' },
        BACKUP: { name: 'Backup', type: 'relation' },
        SELF_BACKUP: { name: 'Self Backup', type: 'relation' },
        MONTH_CHECK: { name: 'Month Check', type: 'relation' },
        WEEK_CHECK: { name: 'Week Check', type: 'relation' },
        YEAR_CHECK: { name: 'Year Check', type: 'relation' },
        MONTH_BACKUP: { name: 'Month Backup', type: 'relation' },
        WEEK_BACKUP: { name: 'Week Backup', type: 'relation' },
        TITLE: { name: 'Title', type: 'title' },
        NOTE: { name: 'Note', type: 'rich_text' },
        CONTENTS: { name: 'Contents', type: 'relation' },

        LAST_MONTH: { name: 'Last Month', type: 'relation' },
        NEXT_MONTH: { name: 'Next Month', type: 'relation' },
        LAST_WEEK: { name: 'Last Week', type: 'relation' },
        NEXT_WEEK: { name: 'Next Week', type: 'relation' }
    }
};

module.exports = Config;
