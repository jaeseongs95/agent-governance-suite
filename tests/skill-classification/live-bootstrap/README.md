# 공개 qualification bootstrap 시험 접점

동결된 r2 runtime과 모의 시험을 그대로 배포하는 접점이다. 제품 기준 commit/tree와 각 파일·fixture oracle의 결속은 `component-manifest.json`에 있다. production profile·설정·선택을 변경하지 않으며 새 의존성을 설치하지 않는다.

원본 바이트를 유지하는 개발용 복사본 두 파일에만 타입 스타일과 비공개 오류 원인 보존에 관한 lint 예외를 둔다. 나머지 파일의 규칙은 유지하며, 별도 strict TypeScript·모의 효과 검사와 SHA 검증으로 이 복사본을 확인한다.

기존 Node.js 24.19와 저장소 `tsx`가 준비된 저장소 루트에서 모의 검사와 공개 REQ 준비를 실행한다.

```sh
node --import tsx tests/skill-classification/live-bootstrap/contract-selfcheck.mts .
node --import tsx tests/skill-classification/live-bootstrap/expiry-regression.mts . tests/skill-classification/live-bootstrap/bootstrap.mts
node --import tsx tests/skill-classification/live-bootstrap/bootstrap.mts prepare /absolute/private/config.json
```

config는 예제를 저장소 밖 private 폴더에 복사한 뒤 `repo`를 현재 저장소 절대 경로, `outputDirectory`를 저장소 밖 별도 private 폴더로 지정한다. key 값·실제 승인·가격·원장은 이 공개 폴더에 넣지 않는다. endpoint와 credential은 ENV 이름으로만 지정한다. 공개 REQ는 기존 loader·frozen 공개 원문 21개·전체 inventory를 보존하며 oracle·label은 provider에 보내지 않는다.

실제 승인 route·현재 가격의 청구 상한·완전한 과거 소비와 unknown 예약·현재 잔여액 근거가 없으면 `run`은 HOLD/BLOCKED다. 단회 과거 token/비용으로 잔액을 계산하지 않는다. 총 USD5 한도는 이전 소비와 예약을 포함한다. evidence의 최소 만료 경계를 예약·credential 조회·fetch 전에 확인한다. timeout/소비 불명 예약은 보존하고 자동 재송신하지 않는다.

위 두 검사는 모의 fetch만 사용한다. 실제 API·credential 조회는 0이며 qualification과 host-live는 NOT_RUN이다. 공개 원문 21개 중 의미 정답 18개와 운영 기본 입력 3개만 기록하며 전체 39유형·120 host paired trials를 완료한 것으로 표시하지 않는다. 실제 실행은 승인과 비용 근거를 별도로 검토한 운영자가 연결한다.
