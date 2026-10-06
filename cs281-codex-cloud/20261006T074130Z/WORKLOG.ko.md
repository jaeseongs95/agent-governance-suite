# AGS 2.8.1 Cloud 회수 작업 로그

네이티브 `read_thread`에서 제공된 명령 31개, MCP 호출 2개, final 보고 4개를 선별 보존했다. 원 Cloud filesystem 전체 회수나 전체 QA 통과를 뜻하지 않는다. 공개 packet은 command/tool/final 허용 항목에 한정하며 이전 빈 capture의 처리 실패 기록은 private에 그대로 보존했다.

| episode | API turn 시각(UTC) | 관측 |
|---|---|---|
| 초기 환경 차단 | 07:12:29–07:15:00 | clean source 확인, managed 진입 미제공 보고; self-delivery 로그 07:14:43 |
| 정적 EP 검토 | 07:17:10–07:17:36 | argv/executable 계약 공백 확인, 실행 NOT_RUN 보고 |
| 재개 | 07:32:30–07:37:42 | cold install 정책 차단, EP 반례·최소 보정, source 검사와 native 91 PASS 보고 |
| 단발 연결 확인 | 07:40:40–07:41:30 | final 보고에서 409 environment_offline; 명령 item 미제공 |

초기 turn ID는 `01a1100e-81e1-77f3-ab96-b9e5dcb7e869`이며 thread ID와 다르다. API epoch 시각과 실행기 내부 출력 시각을 혼합하지 않았다. 재개 실행기 관측 시작은 `07:32:37Z`, 보고 cutoff는 `09:02:37Z`다.

재개 로그에는 npm registry 정책 차단과 pnpm fallback `11.25.0`(요구 `11.19.0` 불일치), 종료 미관측 frozen install wrapper가 남아 있다. prebuild bundle은 esbuild 미발견으로 실패했고 Claude drift는 47개 경고, context references 검사는 실패했다. EP both-away argv 반례 뒤 bounded argv와 executable 일치 보정, Node 91 PASS/source lock 46/self-check가 native 출력 또는 final에 남아 있다. 마지막 context 명령은 exec-server disconnected/recovery timeout으로 실패했고 효과는 UNKNOWN이다.

마지막 Cloud 관측 commit/tree는 `55aea3463a789ceb0e0ab86798170b0057617514` / `9e7249bfee59db034f640e23b2295671bb745654`다. 별도 복구 commit `c9ead430c00156439edb2f88edd3f27c74dc16e0`의 tree 일치는 source 재구성 근거이며 원 commit object 회수나 복구 후보 full QA 근거가 아니다. 원 worker는 source 원격 update/evidence push 0을 보고했다.

`maxOutputCharsPerItem=60000` 요청은 API validation에서 거절됐고, 상한 `20000`으로 유효 read 1회에 성공했다. 서버 출력 잘림 flag는 0이지만 명령 자체의 head/tail/slicing과 출력 없는 명령 1개가 있다. 원 wrapper raw 파일, install 최종 종료, 전체 stdout/stderr, 최종 context 효과, 실제 model/effort 및 VM 신규성은 NOT_VERIFIABLE/UNKNOWN이다. Linux executor 재사용은 원 native 환경 관측·보고 범위다.

Cloud workspace namespace, host home 경로, 이메일, peer message ID만 공개 값에서 제거했다. source→public SHA-256 및 JSON 위치별 제거 기준·횟수는 MANIFEST에 있다. 공개 file digest는 새 bytes 기준이다. 이번 writer는 새 Cloud 실행, 제품 테스트/lint/build/runtime, 설정 변경 및 remote 변경을 수행하지 않았다. root의 범위·게시 검증과 게시 후 fetch 검증은 별도 단계다.
