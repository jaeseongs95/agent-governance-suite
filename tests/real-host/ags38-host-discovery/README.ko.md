# D0013 설치 호스트 관측 경계

원장 `AGS3-D-0013`의 요구는 실제 호스트 설치·지원 관측을 분류 입력에 연결하는 것이다. 기존 producer는 Claude Code만 처리하여 Codex와 Antigravity에서 정상 설치여도 `HOST_DISCOVERY_UNAVAILABLE`을 반환했다. 로컬 트리의 26개 메타데이터와 실제 호스트에서 활성화된 26개 관측은 별개다.

이 수정은 기존 기본 `RuntimeSkillClassificationGateway` → `createInstalledHostSkillObserver` 경로에 두 producer를 추가한다. 공개 tool 인자나 분류 코어에 vendor 필드를 추가하지 않는다. 매 inventory 호출에서 읽기 전용 공식 명령을 다시 실행하며 관측 유효기간은 기존처럼 30초다. 명령 실패·미결속·미검증 형식은 기존 `UNAVAILABLE/local-tree`로 남기고 원시 오류를 공개 응답에 넣지 않는다.

| 호스트 | 직접 확인한 계약 | 현재 지원 범위와 결속 |
| --- | --- | --- |
| Codex CLI 0.166.0 | `--version`, `plugin list --json`, `plugin marketplace list --json`; 공식 add receipt의 `installedPath` | local marketplace만 지원. 이름·버전·pluginId·installed·enabled, marketplace source/root를 대조하고 `CODEX_HOME` 또는 홈의 `.codex/plugins/cache/<market>/<name>/<version>` realpath가 실행 중 registry root와 같아야 한다. `.codex-plugin/plugin.json`의 `skills: ./skills/` 계약도 확인한다. |
| AGY 1.5.2 | `--version`, `plugin list`의 상태·버전·Source·Components; 공식 install stdout의 설치 위치 | 기본 `.gemini/config/plugins/<name>` 설치만 지원. 해당 root의 manifest와 fresh 목록이 일치하고 목록 skill 수와 실제 로드한 inventory 수가 같아야 한다. AGY manifest에 `skills` 필드를 새로 요구하지 않는다. |

공개 근거는 TEST의 `B=/home/mcpops/ags-tests/ags38-01a14016-20261107` 아래 `codex-native-registration-7652`의 공식 add receipt, `codex-native-7652-run.sh`의 캐시 해시 대조, `agy-native-smoke-01a14016-r3/install-native.stdout`, `installed.state.json`, `native-get-skill-inventory-output.json`이다. r3 원 후보는 `8d360bf01e083a12c394f13265330b72c5fc5574`이고 그 실제 설치는 시험 후 공식 제거되었다. 이 과거 실행은 현재 수정의 실제 호스트 성공 근거가 아니다.

동일 이름·버전인 source 복사본, remote Codex source, 중복 등록, 없는 marketplace, 다른 설치 root, 확인되지 않은 CLI 버전·형식은 긍정 관측을 만들지 않는다. sourceRef의 `installed-plugin` 범위는 현재 실행 중인 플러그인 설치이며 호스트 전체 플러그인 조사 완료를 뜻하지 않는다. 다른 호스트·버전·커스텀 AGY 설치 위치는 지원 근거가 없으므로 미지원으로 남는다. Windows의 실제 vendor CLI 실행은 별도 미검증이다.

## 시험 입력과 실행

요구별 선행 사례는 작업 산출물 `v380-host-discovery-cases.md`에 고정했다. 새 suite는 production 기본 gateway를 사용하여 상태·root·중복·형식·오류·disable/requery를 확인한다. Linux 한 사례는 `fixtures/ags38-host-discovery/cli.mjs`를 실행 파일로 놓고 실제 `execFile` → production observer → inventory loader를 통과한다. 이것은 공개 CLI 프로토콜 fixture이며 실제 vendor CLI나 모델 턴 실행을 주장하지 않는다. 기존 Claude 회귀 suite도 함께 실행한다.

```sh
pnpm exec vitest run tests/mcp/ags38-host-discovery-native.test.ts tests/mcp/ags38-core-boundary.test.ts
```

test-only `9d6c1a8eee166a1af1aebd313bf32cd689e95f33`의 Windows TEST는 총29건 중24 PASS/4 FAIL/1 Linux 전용 SKIP, native exit1이었다. 4건 모두 Codex·AGY 정상/disable 관측에서 기대 `COMPLETE/host`, 실제 `UNAVAILABLE/local-tree`였다. 기존 Claude 9건과 신규 거부 15건은 통과했다. 원로그와 종료코드는 `C:/ags-330-test/ags38-d13-red-9d6c1a8e/red-native-python.log`, `red-native.exitcode.txt`에 보존했다. 최초 PowerShell wrapper의 native stderr 처리 오류는 제품 RED에서 제외했다.

수정 후 TEST 결과, 생성 bundle 통합 후 실제 Codex/AGY 설치·단일 native tool 호출 결과는 각각 별도 회수해야 한다. 소스 fixture의 GREEN을 실제 호스트 수용이나 공개 릴리스 완료로 승격하지 않는다. 이 작업에서 로컬 제품시험·설치·전역 설정 변경·인증파일 열람은 수행하지 않는다.
