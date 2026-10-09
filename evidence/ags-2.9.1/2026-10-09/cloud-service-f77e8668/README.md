# AGS 2.9.1 cloud service candidate evidence

이 디렉터리는 비용 보존·캐시 바인딩·qualification 만료 경계를 수정한 **로컬 소스 후보**의 전달 자료다. `evidence` 브랜치에는 자료만 추가했으며 제품 루트에는 패치를 적용하지 않았다. 기존 증거 파일을 보존한다.

- 기준/유일 parent: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- 기준 tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- 원래 후보 commit: `f77e8668ff32246c5a6bb02659472c5610a60792`
- 후보 tree: `150e699ccb04f93e50188fca4ac4cd3c4d2819c0`
- 변경: service.ts + 신규 회귀 테스트 3개, 336 추가 / 5 삭제
- API/Claude 호출 0. 합성 provider 수송과 시계를 사용했다. 실제 비용·잔액·모델 성능을 확정하지 않는다.

## 자료와 검증

- [candidate.patch](candidate.patch): 적용 가능한 공개 패치. author 헤더만 저장소의 기존 공개 표기로 정규화했고 코드 diff는 원본과 바이트 단위로 같다.
- [changed-files.sha256](changed-files.sha256): 적용 후 변경 4파일의 기대 SHA256.
- [test-summary.json](test-summary.json): 사용량 13, 바인딩 14, qualification 15개의 동일 테스트 RED→GREEN 및 기존 관련 161 PASS. 독립 감사 재실행 203/203 PASS. 반복 실행을 별도 커버리지로 합산하지 않았다.
- [independent-audit.md](independent-audit.md): 독립성, 실패 인과, 판정 범위와 한계. **PASS는 정확한 격리 로컬 소스 후보에만 적용**된다.
- [provenance.json](provenance.json): 원본 기록 bytes/SHA256와 공개 패치 bytes/SHA256, 정제 내역 및 변경 통계. 원본과 공개 해시는 서로 구분한다.
- [SHA256SUMS](SHA256SUMS): 공개 파일 무결성 확인용. 원자료의 로컬 경로·대화·환경값·불필요한 원본 로그는 게시하지 않았다.

## 적용 방법 — 총괄의 단일 통합 branch

자료를 확보한 뒤 이 디렉터리에서 `sha256sum -c SHA256SUMS`를 실행한다. 정확한 R13 기준 commit/tree를 확인하고 통합 branch의 기존 작업과 충돌 여부를 검토한다. 이 증거 브랜치에 제품 패치를 적용하지 않는다.

통합 저장소에서 패치의 실제 위치를 `PATCH_FILE`로 지정한 뒤:

```sh
git apply --check "$PATCH_FILE"
git am "$PATCH_FILE"
```

기존 통합 변경 때문에 check가 실패하면 자동으로 최신 branch head로 기준을 바꾸거나 덮어쓰지 말고 총괄이 충돌을 검토한다. 정확한 기준에서만 적용하면 변경 4파일의 해시는 `changed-files.sha256`, 전체 tree는 위 후보 tree와 일치해야 한다. 추가 통합 변경이 존재하면 전체 tree는 달라질 수 있으므로 해당 변경과 검증 범위를 명시한다. 공개 author 정규화 및 새로운 committer/date 때문에 새 commit SHA가 원래 후보 SHA와 같을 것이라고 주장하지 않는다.

합성 검증 재현 명령은 `test-summary.json`에 있다. 이번 게시에는 테스트를 재실행하지 않았다. 통합 후 생성 runtime/Claude bundle을 재생성하고 freshness/build/clean-room/runtime 및 영향 범위 검증을 수행한다.

## NOT_RUN

실모델/API/Claude, 실청구, semantic qualification, 호스트 E2E, 전체 1257 suite, R14, 재시작/전역 claim 재설계, 생성 bundle freshness/build/clean-room은 이 후보 검증에서 실행하지 않았다. 독립 감사 PASS는 통합·배포·릴리스 승인을 포함하지 않는다. provider 내부 비동기 wire-time qualification, 숨겨진 route/credential 변경과 durable/global budget은 이 service 경계로 입증하지 않는다.
