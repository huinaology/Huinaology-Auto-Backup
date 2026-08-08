# 🌸 Huinaology-Auto-Backup Widget
휘나올로지 게으른 맥시멀리스트를 위한 노션 템플릿 사용자를 위한 자동 백업 연결 시스템.
휘나올로지 노션 템플릿의 구조에 맞춰 설계되어 데이터를 안전하게 백업하고, 페이지를 자동으로 생성 및 연결해주는 위젯입니다.
All-in-One 템플릿 사용자는 물론, 단일 템플릿 구매자도 사용하실 수 있습니다.

2027년 이전 버전 사용자의 경우, 위젯이 올바르게 작동할 수 있도록 기존 속성의 이름을 정리해야 올바르게 작동합니다.
구매 링크에 포함된 업데이트에 따라 속성명을 정리하신 후, 위젯을 설정 해 주시기 바랍니다.

## 🚀 준비
1. 노션 개발자 센터에서 노션 API 발급 (https://app.notion.com/developers/connections)
2. Github 계정 생성 (https://github.com/)
3. Vercel 계정 생성 (https://vercel.com/)

### 🛠️ 위젯 업데이트 방법 (Update Guide)
위젯 설정 탭에서 새로운 버전 알람이 뜰 경우, 아래 순서대로 간편하게 업데이트하실 수 있습니다.

1. 본 안내서 상단의 [깃허브 원본 저장소 링크]로 이동합니다.
2. 변경점이 생긴 파일을 클릭하여 들어간 뒤, 전체 코드를 복사(Ctrl+A 후 Ctrl+C)합니다.
3. 사용자 본인의 깃허브 저장소로 이동하여 동일한 파일을 엽니다.
4. 우측 상단의 **[Edit this file] (연필 아이콘)**을 누르고 기존 코드를 지운 뒤 새 코드를 붙여넣습니다.
5. 페이지 하단의 **[Commit changes...]** 버튼을 눌러 저장합니다.
6. [Vercel 대시보드](https://vercel.com/dashboard)로 이동해 해당 프로젝트의 **[Deployments] ➔ [...] ➔ [Redeploy]**를 누르면 끝납니다.

#### 🚀 1초 만에 내 노션과 연결하기
아래 버튼을 누르면 Vercel을 통해 위젯이 무료로 자동 배포됩니다.
(배포 과정에서 Notion API 토큰과 백업할 DB ID 입력창이 나타납니다.)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/huinaology/Huinaology-Auto-Backup&env=WIDGET_SECRET,NOTION_TOKEN,ANNUAL_DB_ID,MONTHLY_DB_ID,WEEKLY_DB_ID,DAILY_DB_ID,FIN_MONTHLY_DB_ID,FIN_WEEKLY_DB_ID,PERSONAL_MASTER_DB_ID,FINANCE_MASTER_DB_ID,MEDIA_MASTER_DB_ID)
