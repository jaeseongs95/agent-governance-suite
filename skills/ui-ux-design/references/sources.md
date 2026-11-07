# 출처와 적용 범위

작성 기준: 2026-11-06. 아래 공식 자료는 대상이 화면일 때의 설계·구현·검증용이다. 그때 필요한 범위에서 적용하라. 인쇄·영상·공간·제품·서비스·문서에는 [검증 기준](verification.md)의 대상 사용자 확인을 먼저 적용하고, 그 매체에 정해진 규격·법규·표준은 실제 대상 환경에서 확인해 따르라. 대상이 화면일 때 쓰는 수치 기준을 다른 매체에 그대로 옮기지 마라. 제품별 지원 기능과 표준의 세부 조건은 실제 사용 환경과 목표 수준에 맞춰 확인하라.

| 출처 | 적용할 내용과 범위 |
| --- | --- |
| [W3C WAI: WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/) | 키보드, 초점, 대비, 확대·재배치, 입력 오류와 상태 전달의 관련 기준을 확인하라. 수치·등급·예외를 함께 읽고 일부 점검을 전체 준수 선언으로 확대하지 마라. |
| [W3C WAI: APG Read Me First](https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/) | 의미 있는 기본 요소를 우선하고 ARIA 역할·상태와 실제 동작을 일치시켜라. 예제 복사만으로 접근성 검증을 대신하지 마라. |
| [W3C WAI: Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | 웹이면 모달의 초점 이동·내부 키보드 탐색·닫기·초점 복귀와 배경 상호작용 제약을 설계하라. 비모달이나 네이티브 앱에는 실제 플랫폼의 대응 방식을 적용하라. |
| [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) | 웹이면 지원되는 비동기 작업의 취소 수단을 확인하라. 클라이언트 요청 취소와 서버의 작업 취소·롤백을 같은 것으로 가정하지 마라. |
| [web.dev: Virtualize large lists with react-window](https://web.dev/articles/virtualize-long-lists-react-window) | 큰 목록에서 그리는 구간을 제한하고 주변 항목을 유지하는 접근을 참고하라. React나 react-window를 모든 프로젝트의 필수 의존성으로 만들지 마라. |

## AGS와 제품별 결정

- 공통 행동 기준은 [전문 스킬 공통 행동 기준](../../independent-audit-gate/references/specialist-behavior.md), 역할과 단계 경계는 [AGS 역할 경계](ags-boundaries.md)를 따르라.
- 요청별 흐름·정보 계층·한국어 문구·입력·캐시와 자원 수명에 관한 작업 판단은 실제 결과물의 원본·디자인 체계·동작 계약에 맞춰라. 위 자료가 특정 제품의 최적 설계나 보편적 성능 목표를 정해 준다고 하지 마라.
- 추가 디자인 서비스·평가 모델·유료 도구·새 기반 도구(예: 프레임워크)를 필수 의존성으로 삼지 마라. 사용할 수 있는 도구와 기존 결과물로 요청한 결과를 완성하라.
