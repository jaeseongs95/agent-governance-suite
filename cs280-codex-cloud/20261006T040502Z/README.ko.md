# CS 2.8.0 Codex Cloud 공개 증거 사본

original/r1/r2는 서로 다른 source pin의 실행·진단·후처리 자료다. 후보별 claim은 CLAIMS.json을 따른다. 실패·보정·exit7·worker 오류·공식 validator BLOCKED와 NOT_RUN을 보존했다. 이번 게시에서 새 제품 테스트나 제품 변경은 실행하지 않았다.

원본은 비공개 동결 사본으로 보존했다. REDACTION.json은 파일별 원본/공개 bytes·SHA256과 제거 종류/횟수를 고정한다. MANIFEST.json은 공개 payload의 exact 파일 집합을 고정하며 자체 해시는 별도 SHA256SUMS에 있다. removalCount는 제거된 raw 토큰 수가 아니라 규칙의 매칭·필드 제거 횟수다. JSON/log header의 표기 정규화도 원본 hash 차이를 만들 수 있다. 원 SHA가 있다는 사실만으로 제거된 원문이나 원 transcript를 공개 검증할 수 있다는 뜻은 아니다.

native 전체 transcript와 분리된 tool stdout/stderr는 제공되지 않았다. COMMAND-COVERAGE.json과 NOT-VERIFIABLE.json에 실제 보유·미제공 범위를 적었다. ZIP/Gitbundle/DB/WAL/key/trustfile/sourcepatch는 공개 제외다. SQLite fixture/PID/queue 관측 JSONL·JSON은 데이터베이스 파일이 아니며 민감 필드 제거 후 포함했다. 공개 payload만 residual scan과 직접 검토했다. 기존 evidence 폴더와 main/source branch는 수정하지 않는다.

r1 supervised PASS는 3b9c pin의 조건부 Linux 결과다. r2 f791 전체 회귀는 NOT_RUN이다. 외부 static SOURCE metadata는 실행·출시 권한이 아니며 확인하지 못한 verdict는 NOT_VERIFIABLE다. signed1.1 전체 lifecycle·전역 acceptance는 NOT_IMPLEMENTED를 유지한다.

공개 후처리 스크립트는 민감 리터럴까지 제거한 감사용 사본이다. 실행 가능한 원본 스크립트는 비공개 보존하며, 이 사본을 그대로 실행하는 재현성을 주장하지 않는다.
