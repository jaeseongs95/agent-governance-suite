# D0013 설치 호스트 관측 경계

원장 `AGS3-D-0013`의 요구는 실제 호스트 설치·지원 관측을 분류 입력에 연결하는 것이다. 기존 producer는 Claude Code만 처리하여 Codex와 Antigravity에서 정상 설치여도 `HOST_DISCOVERY_UNAVAILABLE`을 반환했다. 로컬 트리의 26개 메타데이터와 실제 호스트에서 활성화된 26개 관측은 별개다.

이 수정은 기존 기본 `RuntimeSkillClassificationGateway` → `createInstalledHostSkillObserver` 경로에 두 producer를 추가한다. 공개 tool 인자나 분류 코어에 vendor 필드를 추가하지 않는다. 매 inventory 호출에서 읽기 전용 공식 명령을 다시 실행하며 관측 유효기간은 기존처럼 30초다. 명령 실패·미결속·미검증 형식은 기존 `UNAVAILABLE/local-tree`로 남기고 원시 오류를 공개 응답에 넣지 않는다.

| 호스트 | 직접 확인한 계약 | 현재 지원 범위와 결속 |
| --- | --- | --- |
| Codex CLI 0.166.0 | `--version`, `plugin list --marketplace <market> --json`, `plugin marketplace list --json`; 공식 add receipt의 `installedPath` | local marketplace만 지원. `CODEX_HOME` 또는 홈의 `.codex/plugins/cache/<market>/<name>/<version>` realpath와 실행 registry root를 먼저 결속한다. 그 시장만 조회하고 이름·버전·pluginId·installed·enabled를 대조한다. plugin의 marketplaceSource는 시장 root와 같아야 하며 source는 그 root 또는 canonical 하위 경로여야 한다. `.codex-plugin/plugin.json`의 `skills: ./skills/` 계약도 확인한다. |
| AGY 1.5.2 | `--version`, `plugin list`의 상태·버전·Source·Components; 공식 install stdout의 설치 위치 | 기본 `.gemini/config/plugins/<name>` 설치만 지원. 해당 root의 manifest와 fresh 목록이 일치하고 목록 skill 수와 실제 로드한 inventory 수가 같아야 한다. AGY manifest에 `skills` 필드를 새로 요구하지 않는다. |

공개 근거는 TEST의 `B=/home/mcpops/ags-tests/ags38-01a14016-20261107` 아래 `codex-native-registration-7652`의 공식 add receipt, `codex-native-7652-run.sh`의 캐시 해시 대조, `agy-native-smoke-01a14016-r3/install-native.stdout`, `installed.state.json`, `native-get-skill-inventory-output.json`이다. r3 원 후보는 `8d360bf01e083a12c394f13265330b72c5fc5574`이고 그 실제 설치는 시험 후 공식 제거되었다. 이 과거 실행은 현재 수정의 실제 호스트 성공 근거가 아니다.

동일 이름·버전인 source 복사본, remote Codex source, 중복 등록, 없는 marketplace, 다른 설치 root, 확인되지 않은 CLI 버전·형식은 긍정 관측을 만들지 않는다. sourceRef의 `installed-plugin` 범위는 현재 실행 중인 플러그인 설치이며 호스트 전체 플러그인 조사 완료를 뜻하지 않는다. 다른 호스트·버전·커스텀 AGY 설치 위치는 지원 근거가 없으므로 미지원으로 남는다. Windows 실제 설치에서 inventory가 COMPLETE인지 여부는 아직 별도 미결이다.

## 시험 입력과 실행

요구별 선행 사례는 작업 산출물 `v380-host-discovery-cases.md`에 고정했다. 새 suite는 production 기본 gateway를 사용하여 상태·root·중복·형식·오류·disable/requery를 확인한다. Linux 한 사례는 `fixtures/ags38-host-discovery/cli.mjs`를 실행 파일로 놓고 실제 `execFile` → production observer → inventory loader를 통과한다. 이것은 공개 CLI 프로토콜 fixture이며 실제 vendor CLI나 모델 턴 실행을 주장하지 않는다. 기존 Claude 회귀 suite도 함께 실행한다.

```sh
pnpm exec vitest run tests/mcp/ags38-host-discovery-native.test.ts tests/mcp/ags38-core-boundary.test.ts
```

test-only `9d6c1a8eee166a1af1aebd313bf32cd689e95f33`의 Windows TEST는 총29건 중24 PASS/4 FAIL/1 Linux 전용 SKIP, native exit1이었다. 4건 모두 Codex·AGY 정상/disable 관측에서 기대 `COMPLETE/host`, 실제 `UNAVAILABLE/local-tree`였다. 기존 Claude 9건과 신규 거부 15건은 통과했다. 원로그와 종료코드는 `C:/ags-330-test/ags38-d13-red-9d6c1a8e/red-native-python.log`, `red-native.exitcode.txt`에 보존했다. 최초 PowerShell wrapper의 native stderr 처리 오류는 제품 RED에서 제외했다.

수정 `d2eefae5e8d2e94b2a5ff497824c86f8d126b86b`의 동일 Windows TEST는 28 PASS/1 Linux 전용 SKIP, native exit0이었다. 로그·종료코드는 `C:/ags-330-test/ags38-d13-green-d2eefae5/green-native.log`, `green-native.exitcode.txt`에 있다. Linux에서는 같은 SHA의 실제 execFile 사례 1건만 실행해 PASS, 필터 외19건 제외, native exit0을 확인했다. 로그·종료코드는 `B/d13-cli-d2eefae5/green-cli.log`, `green-cli.exitcode.txt`다. 로컬에서는 tsc, 대상 eslint, fixture node --check, git diff --check만 실행했고 모두 exit0이었다.

생성 bundle 통합 후 실제 Codex/AGY 설치·단일 native tool 호출 결과는 별도 회수해야 한다. 소스 fixture의 GREEN을 실제 호스트 수용이나 공개 릴리스 완료로 승격하지 않는다. 이 작업에서 로컬 제품시험·설치·전역 설정 변경·인증파일 열람은 수행하지 않는다.

## Windows 실제 CLI와 relative child에서 확인한 후속 원인

Windows TEST의 기존 공식 Codex는 npm `codex.ps1/codex.cmd`, Claude는 `.local/bin/claude.exe`였다. 정상 명령 셸에서 `cmd /c codex --version`은 성공했지만 Node24.22.2 `execFile('codex', ...)`의 version/list는 ENOENT(-4058)였다. Claude의 version/list는 양쪽 모두 성공했다. Python source 실행기의 PATH 부재로 모든 명령이 시작 전에 실패한 최초 진단은 이 원인과 구분해 보존했다.

최종 Codex adapter는 Windows ENOENT에서만 공개 npm shim의 공식 package/bin, version0.166.0, optional platform package를 확인하여 공식 `vendor/<triple>/bin/codex.exe`를 직접 실행한다. Node launcher나 cmd를 실행하지 않고 원 인자를 전달한다. command의 5초 제한·1MB 출력 제한을 유지하므로 timeout 시 직접 관찰하는 native process가 종료 대상이다. 공식 설치 경로가 없거나 모호하면 UNAVAILABLE이다. shell:true, 명령 문자열 합성, 전역 PATH 변경은 없다.

실제 source helper `fd6ba45603cfaae2fcca4e19f74e493dd8c9d644`가 선택한 경로는 `C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`였다. 실제 version은67ms, marketplace list는111ms, `plugin list --help`는70ms에 성공했다. 이 파일은 실제 공식 설치본이며 시험의 가짜 exe 파일과 구분한다. 원 bare ENOENT, wrapper list5초 timeout, 직접 native list20초 timeout을 모두 보존한다. 실제 help는 remote marketplaces를 포함하는 목록이며 공식 `--marketplace` 필터를 제공한다. 전역 목록을 반복하거나 production timeout을 늘리지 않는다. 자기 Node6616의 child 및 직접 native20224는 최종 조회에서 잔류0이었다.

Windows native 전용 test-only `098b3a46575609fb6b1decef34187f983f41749d`는 표적5건 중2FAIL/3PASS(exit1), `fd6ba456`은 전체34건 중33PASS/1Linux전용SKIP(exit0)이었다. 이 전용 시험은 처음4FAIL의 시험과 다른 판이며 같은 red/green 근거로 합치지 않는다. `C:/ags-330-test/d13-native-red-098b3a46/red.log`, `d13-native-green-fd6ba456/green.log`, 각 exitcode 파일과 `actual-native-result.json`을 보존했다.

Linux 실제 candidate `d826183e47891dc977416ef8182b3656d86e3fb0`는 relative child를 공식 설치했지만 native inventory가 여전히 UNAVAILABLE였다. 공개 `installed-public-row-proof.json`을 직접 읽어 source.path가 marketplace/agent-governance-suite이고 marketplaceSource.source와 marketplace.root는 marketplace임을 확인했다. 기존 source==market 조건이 정상 child를 거부했다. 같은 공개 행의 이름·버전·pluginId·출처·policy를 보존하고 파일시스템 prefix만 옮긴 회귀 사례를 추가했다. 실행시 registry realpath는 해당 실제 회차에 별도 기록되지 않았으므로 관측했다고 주장하지 않는다.

후속 test-only `f7640251d670eaf1e3ec617fe2e736dbe63fc9bb`의 Linux 표적4건은 정상 child/시장한정 조회2FAIL, 잘못된 marketplace 출처/시장 밖 source2PASS(exit1)였다. 근거는 `B/d13-relative-red-f7640251/red.log`, `red.exitcode.txt`다. 최종 source `7875812982f91f83f61fb048f1b6fcdb53cb98be`는 canonical cache 결속 → 공식 시장 목록 → 해당 시장만 plugin 목록 → 출처/하위 경로 대조 순서로 수리했다.

이 최종 source의 같은 runner는 Linux 총38건 중33PASS/5Windows전용SKIP(exit0,2.00초), Windows 총38건 중37PASS/1Linux전용SKIP(exit0,4.36초)이었다. 원로그와 종료코드는 `B/d13-final-green-78758129/green.log`, `green.exitcode.txt`, `C:/ags-330-test/d13-final-win-green-78758129/green.log`, `green.exitcode.txt`다. 로컬 tsc/대상 eslint/diff는 exit0이며 로컬 제품시험은 실행하지 않았다.

같은 최종 source의 Windows 실제 helper는 공식 native.exe로 `plugin list --marketplace openai-curated --json`을 실행해135ms에 `installed: [], available: []`를 받았다. 이 기존 시장은 비어 있으므로 해당 조회 성공을 AGS 설치나 실제 inventory COMPLETE로 승격하지 않는다. 원결과는 `C:/ags-330-test/d13-final-win-green-78758129/actual-native-result.json`, runner 종료코드는 `actual-filtered.exitcode.txt`다. 전역 목록의 원5초/20초 timeout은 보존한다. 최종 bundle에서 실제 AGS 설치의 native inventory 수용은 root의 별도 검증으로 남는다.
