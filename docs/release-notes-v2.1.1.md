# v2.1.1 — 세션 메시징 이식성 수정

## 변경

- 세션 메시지 본문에 NUL(`U+0000`) 문자를 허용하지 않습니다. 지원하는 Node.js와 운영체제 조합에서 `node:sqlite` TEXT 왕복 결과가 일관되지 않아, 수락한 본문을 그대로 전달한다는 계약을 보장할 수 없었기 때문입니다.
- 32KiB broker 응답 frame의 JSON escape 경계 테스트는 같은 6배 확장 특성을 가진 `U+0001` fixture로 유지합니다.
- NUL 본문이 spool에 저장되지 않고 명시적인 입력 오류로 거부되는 회귀 테스트를 추가했습니다.
- Windows의 호스트 프로세스 시작 시각 조회를 WMI 대신 `Get-Process`로 바꾸고 호출 제한 시간을 3초에서 5초로 늘렸습니다.

## 릴리스 관계

- v2.1.0의 TLS 1.3 세션 메시징, 공용 홈 상태 경로, 중복 wake 억제와 호스트 중립 계약은 그대로 유지합니다.
- v2.1.0 공개 뒤 GitHub Actions의 Windows Node.js 22와 Ubuntu Node.js 22에서 NUL 본문 왕복 테스트가 실패했고, Windows Node.js 22·24에서는 프로세스 시작 시각 조회가 토큰을 반환하지 못해 설치를 보류했습니다. v2.1.1은 두 이식성 결함만 좁게 수정한 권장 패치 릴리스입니다.

## 검증

- Windows 로컬 Node.js 24에서 session messaging 테스트 24개가 통과했습니다.
- 전체 저장소 검증과 GitHub Actions Node.js 22·24, Ubuntu·Windows 매트릭스는 v2.1.1 후보에서 다시 확인합니다.
