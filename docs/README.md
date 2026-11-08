# 문서

한국어 문서가 정본입니다. 영어는 [README.en.md](../README.en.md)가 같은 내용을 옮깁니다.

## 사용자 문서

AGS를 설치해 쓰는 사람을 위한 문서입니다. 설치는 [README](../README.md#설치)에 있습니다.

| 문서 | 내용 |
| --- | --- |
| [사용하기](user/usage.md) | 요청하는 법, 설치하면 달라지는 동작, workflow와 편집 관문, 작업 기록, 하위 작업의 모델 선택, 보장하지 않는 것 |
| [관리자 페이지와 컨텍스트](user/admin-page.md) | 로컬 관리자 페이지, 전역·담당·상황 컨텍스트, JEV, 표시 언어, 재설정 |
| [세션 협업](user/collaboration.md) | 현황판, PEER 메시지, 호스트별 깨우기, Codex queue wake 설정 |
| [상태 저장과 정리](user/state.md) | 상태 파일 위치와 환경 변수, 정리·백업·복구 |
| [업데이트와 이전](user/update.md) | 새 판 알림, 업데이트 절차, 언어 패키지, 이전 판에서 올리기 |
| [3.8.0 업그레이드와 기존 데이터 이관](user/migrate-to-v3.8.0.md) | 3.7 이하에서 올릴 때의 작업 기록 DB 백업·이관·복구 |
| [문제 해결](user/troubleshooting.md) | 증상별 확인할 것 |

## 기여자 문서

AGS 자체를 고치는 사람을 위한 문서입니다. 시작은 [기여 안내](../CONTRIBUTING.md)입니다.

| 문서 | 내용 |
| --- | --- |
| [아키텍처](contributing/architecture.md) | 스킬·계약·MCP 서버 구조, 실행 관측, 작업 기록, 현황판, 메시지 저장소, 검사 범위, 저장소 구조 |
| [개발 참고](contributing/development.md) | 개발 환경, 검증 명령, 생성물, 동결 평가, 스킬 추가·편입 |
| [시험과 CI](contributing/testing-and-ci.md) | CI와 시험 서버의 역할, 시험 범위 나누기 |
| [발행](contributing/release.md) | 판 번호, 릴리스 노트, 발행 전 점검, 공급망 |
| [국제화](contributing/i18n.md) | locale 결정, 메시지 카탈로그, 영어 전용 배포물 |
| [실행 관측과 호스트 연결](contributing/execution-attestation.md) | 호스트별 실행 관측 출처와 실패 코드 |
| [세션 메시지 계약](contributing/session-messaging.md) | 메시지 ID·재시도·회수·ACK, 깨우기, presence, peer 대기 판정 |
| [입력 출처와 작업 경계](contributing/input-boundaries.md) | 입력 출처 구분, 수신·재전달, workflow 원장의 쓰기 대상 |
| [관리자 서명 기록과 설정 읽기](contributing/admin-log.md) | 서명 기록 형식·검증, 설정 읽기, JEV 구성, 오류 코드 |
| [로드맵](contributing/roadmap.md) | 단계별 계획과 상태 |

## 보관 기록과 릴리스 노트

- [보관 기록](archive/README.md): 지난 설계안과 결정 기록입니다. 작성 당시 내용 그대로입니다.
- [릴리스 노트](release-notes/): 판마다 `release-notes-v<버전>.md` 하나입니다. GitHub Release 본문도 이 파일로 만듭니다.
