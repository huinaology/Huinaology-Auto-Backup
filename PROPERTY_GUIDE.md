# 🧩 속성명 정리 가이드 (이전 버전 템플릿 사용자용)

이 가이드는 **2027년 이전 버전 템플릿**을 쓰고 계시거나, 속성 이름을 직접 바꿔 쓰신 적이 있는 분을 위한 문서입니다.
2027 템플릿을 새로 구매해 그대로 쓰신다면 읽지 않으셔도 됩니다.

---

## 1. 왜 속성 이름이 중요한가요?

위젯은 노션 속성을 **이름으로** 찾습니다. 그것도 **대소문자와 띄어쓰기까지 글자 그대로** 같아야 합니다.

| 노션에 있는 이름 | 위젯이 찾는 이름 | 결과 |
|---|---|---|
| `Month Check` | `Month Check` | ✅ 정상 |
| `month check` | `Month Check` | ❌ 못 찾음 (대소문자가 다름) |
| `Last` | `Last Month` | ❌ 못 찾음 |
| `Year Check` (Daily DB) | `Year` | ❌ 못 찾음 |

> ⚠️ 더 곤란한 점: 속성을 못 찾아도 **에러가 나지 않고 그 연결만 조용히 건너뜁니다.**
> "분명히 실행했는데 Week Check만 비어 있다"는 증상이 바로 이 경우입니다.

그래서 위젯 안에 **속성명 점검** 기능을 만들어 두었습니다. 노션 DB를 읽기만 하고 **아무것도 수정하지 않습니다.**

---

## 2. 3단계로 정리하기

### 1단계 — 점검 실행하기
1. 위젯을 열고 화면 맨 위 아이콘 탭 중 가장 오른쪽 **⚙️ (설정)** 탭으로 이동합니다.
2. **🧩 속성명 점검** 카드의 **[🔎 속성명 점검 실행]** 버튼을 누릅니다.
3. 몇 초 뒤 DB별 결과가 나옵니다. (환경변수에 ID를 넣어 둔 DB만 점검합니다)

### 2단계 — 결과 읽기

| 표시 | 뜻 | 해야 할 일 |
|---|---|---|
| ✅ | 이름·종류·연결 대상이 모두 맞음 | 없음 |
| 🔤 | 이름이 **대소문자/띄어쓰기만** 다름 | 노션에서 이름을 정확히 고치기 |
| ❌ | **필수 속성이 없음** (비슷한 이름이 있으면 💡로 알려 드려요) | 이름 바꾸기 또는 속성 추가 |
| ⚠️ | 이름은 같은데 **속성 종류**가 다름 | 템플릿 원본과 같은 종류로 맞추기 |
| 🔗 | 이름은 같은데 **엉뚱한 DB**를 가리킴 | 연결 대상 DB 바로잡기 |
| ➖ | **선택 속성**이 없음 | 안 고쳐도 됩니다 (해당 부가 기능만 빠짐) |

💡 표시는 "이 속성이 그 항목일 것 같다"는 **추측**입니다. 확정이 아니니, 제안된 속성이 정말 같은 역할인지 확인하고 바꿔 주세요.

### 3단계 — 노션에서 이름 고치고 다시 점검하기
1. 해당 DB를 **표(테이블) 보기**로 엽니다.
2. 고칠 속성의 **열 이름을 클릭 → 이름 칸을 수정 → Enter**.
3. 위젯에서 **[🔎 속성명 점검 다시 실행]**. 노션 쪽은 바로 반영되므로 기다릴 필요가 없습니다.
4. 필수 항목(❌ 🔤 ⚠️ 🔗)이 모두 없어질 때까지 반복합니다.

**참고**
- 속성 **이름만** 바꾸면 기존에 입력된 값과 연결은 그대로 유지됩니다.
- 이 속성을 쓰는 수식(Formula)은 노션이 대부분 자동으로 따라 바꿔 줍니다. 그래도 바꾼 뒤 수식 칸에 오류 표시가 없는지 한 번 훑어 보세요.
- 불안하시다면 **한 번에 하나씩** 바꾸고, 바꿀 때마다 점검으로 확인하며 진행하세요. 이름 변경은 입력된 값을 지우지 않습니다.
- 관계형(Relation) 속성은 DB 양쪽에 따로 이름이 있습니다. **위젯이 보는 것은 "이 DB 쪽" 속성의 이름**입니다.

---

## 3. 가장 흔한 헷갈림 ⭐

### `Year` vs `Year Check`
연도를 연결하는 속성은 DB 종류에 따라 **이름이 다릅니다.**

| DB 종류 | 연도 연결 속성 이름 |
|---|---|
| Daily / Weekly / Monthly / Finance Weekly / Finance Monthly (**아카이브**) | `Year` |
| Personal Master / Finance Master / Media Master (**마스터**) | `Year Check` |

### `Last` / `Next` → `Last Month` / `Next Month` / `Last Week` / `Next Week`
예전 버전에서는 이전/다음 페이지 연결을 짧게 `Last`, `Next`로 쓰던 경우가 있습니다.
현재는 Monthly 계열은 `Last Month` / `Next Month`, Weekly 계열은 `Last Week` / `Next Week` 입니다.

### `Title`은 신경 쓰지 않으셔도 됩니다
제목 속성은 이름이 아니라 **"제목(title) 종류"**로 찾기 때문에 `Name`, `이름` 등 어떤 이름이어도 됩니다.

---

## 4. DB별 필요한 속성 이름 표

**필수** = 없으면 해당 연결 기능이 건너뛰어짐 / **선택** = 없어도 핵심 기능은 동작

### Daily Archive (`DAILY_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Backup` | 관계형 | Daily 자기 자신 | 필수 |
| `Month Check` | 관계형 | Monthly Archive | 필수 |
| `Week Check` | 관계형 | Weekly Archive | 필수 |
| `Year` | 관계형 | Annual Archive | 필수 |
| `Note` | 텍스트 | - | 선택 |

### Weekly Archive (`WEEKLY_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Week Check` | 관계형 | Weekly 자기 자신 | 필수 |
| `Last Week` | 관계형 | Weekly 자기 자신 | 필수 |
| `Next Week` | 관계형 | Weekly 자기 자신 | 필수 |
| `Month Check` | 관계형 | Monthly Archive | 필수 |
| `Year` | 관계형 | Annual Archive | 필수 |
| `Backup` | 관계형 | Daily Archive | 선택 |

### Monthly Archive (`MONTHLY_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Month Check` | 관계형 | Monthly 자기 자신 | 필수 |
| `Last Month` | 관계형 | Monthly 자기 자신 | 필수 |
| `Next Month` | 관계형 | Monthly 자기 자신 | 필수 |
| `Year` | 관계형 | Annual Archive | 필수 |
| `Week Check` | 관계형 | Weekly Archive | 선택 |
| `Backup` | 관계형 | Daily Archive | 선택 |

### Annual Archive (`ANNUAL_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |

### Finance Weekly Archive (`FIN_WEEKLY_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Week Check` | 관계형 | Finance Weekly 자기 자신 | 필수 |
| `Last Week` | 관계형 | Finance Weekly 자기 자신 | 필수 |
| `Next Week` | 관계형 | Finance Weekly 자기 자신 | 필수 |
| `Month Check` | 관계형 | **Finance** Monthly Archive | 필수 |
| `Week Backup` | 관계형 | (일반) Weekly Archive | 필수 |
| `Month Backup` | 관계형 | (일반) Monthly Archive | 필수 |
| `Year` | 관계형 | Annual Archive | 필수 |

### Finance Monthly Archive (`FIN_MONTHLY_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Month Check` | 관계형 | Finance Monthly 자기 자신 | 필수 |
| `Last Month` | 관계형 | Finance Monthly 자기 자신 | 필수 |
| `Next Month` | 관계형 | Finance Monthly 자기 자신 | 필수 |
| `Month Backup` | 관계형 | (일반) Monthly Archive | 필수 |
| `Year` | 관계형 | Annual Archive | 필수 |

### Personal Master (`PERSONAL_MASTER_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Backup` | 관계형 | Daily Archive | 필수 |
| `Week Check` | 관계형 | Weekly Archive | 필수 |
| `Month Check` | 관계형 | Monthly Archive | 필수 |
| `Year Check` | 관계형 | Annual Archive | 필수 |
| `Self Backup` | 관계형 | Personal Master 자기 자신 | 선택 |
| `Final Update` | 날짜 | - | 선택 |
| `⏲️ipr Calendar` | 수식 | - | 선택 |
| `Contents` | 관계형 | Contents DB | 선택 (Holiday Generator) |
| `Note` | 텍스트 | - | 선택 |

### Finance Master (`FINANCE_MASTER_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Backup` | 관계형 | Daily Archive | 필수 |
| `Week Backup` | 관계형 | (일반) Weekly Archive | 필수 |
| `Month Backup` | 관계형 | (일반) Monthly Archive | 필수 |
| `Week Check` | 관계형 | **Finance** Weekly Archive | 필수 |
| `Month Check` | 관계형 | **Finance** Monthly Archive | 필수 |
| `Year Check` | 관계형 | Annual Archive | 필수 |
| `Self Backup` | 관계형 | Finance Master 자기 자신 | 선택 |
| `Final Update` | 날짜 | - | 선택 |

### Media Master (`MEDIA_MASTER_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Backup` | 관계형 | Daily Archive | 필수 |
| `Week Check` | 관계형 | Weekly Archive | 필수 |
| `Month Check` | 관계형 | Monthly Archive | 필수 |
| `Year Check` | 관계형 | Annual Archive | 필수 |
| `Self Backup` | 관계형 | Media Master 자기 자신 | 선택 |
| `Final Update` | 날짜 | - | 선택 |
| `⏲️ipr Calendar` | 수식 | - | 선택 |

### Time Table / Timeline (`TIMELINE_DB_ID`), Pomodoro (`POMODORO_DB_ID`)
| 속성 이름 | 종류 | 연결 대상 | 필수 |
|---|---|---|---|
| `Schedule` | 날짜 | - | 필수 |
| `Backup` | 관계형 | Daily Archive | 필수 |

---

## 5. 점검 결과로 AI에게 도움받기

점검 결과 아래에 **[📋 결과 복사]** 버튼이 있습니다. 눌러서 복사한 뒤 AI에게 이렇게 물어보세요.

```
노션 자동 백업 위젯의 "속성명 점검" 결과입니다.
노션에서 어떤 속성의 이름을 어떻게 바꿔야 하는지, 한 단계씩 쉽게 알려 주세요.
(저는 노션 사용법은 알지만 프로그래밍은 전혀 모릅니다)

[여기에 복사한 결과 붙여넣기]
```

> 🔒 AI에게 **노션 토큰, 위젯 비밀번호(WIDGET_SECRET), `?key=` 가 붙은 주소**는 붙여넣지 마세요.
> 점검 결과에는 그런 정보가 들어 있지 않으니 안심하고 복사하셔도 됩니다.

---

## 6. 자주 묻는 질문

**Q. 속성 이름을 바꾸고 싶지 않아요. 위젯이 제 이름에 맞춰줄 수는 없나요?**
A. 현재는 위젯이 정해진 이름만 인식합니다. 이름을 맞추는 쪽이 가장 안전합니다. (자동으로 이름을 바꿔 주는 기능은, 사용자의 DB를 임의로 수정하게 되어 일부러 넣지 않았습니다.)

**Q. ➖ 선택 속성이 없다고 나오는데 꼭 만들어야 하나요?**
A. 아니요. 해당 부가 기능(예: 진행 중 일정의 기간 계산, Holiday의 Contents 연결)만 빠질 뿐 핵심 연결은 동작합니다.

**Q. 점검했는데 어떤 DB가 아예 안 보여요.**
A. 환경변수에 그 DB의 ID가 비어 있으면 점검에서 제외됩니다. 쓰지 않는 DB라면 정상입니다.

**Q. ❌ "DB를 열 수 없어 점검하지 못했습니다"가 나와요.**
A. DB ID가 틀렸거나, 노션에서 그 DB(또는 상위 페이지)에 위젯용 연동(Connections)이 추가되지 않은 경우입니다. 연동을 추가한 직후라면 반영까지 몇 분 걸릴 수 있어요. 설치 매뉴얼의 "문제 해결"을 참고해 주세요.

**Q. 이름을 다 고쳤는데도 예전 페이지의 연결이 비어 있어요.**
A. 이름을 고친 뒤 **Data Sync 탭 → Recent Resync** 또는 **Range Restore**를 실행하면, 빠진 연결을 다시 채워 줍니다. (Generator & Linker 탭의 STEP 2 연결 버튼으로도 채울 수 있습니다)
