# 공급망과 릴리스 메타데이터

`skills/source-lock.json` v2는 각 스킬의 원본 저장소·하위 경로·버전·ref 종류·peeled commit·원본 checksum·통합본 checksum·업데이트 정책을 함께 고정한다. `pnpm source:check`는 네트워크 없이 registry, 직접 descriptor, `SKILL.md` metadata 또는 legacy `VERSION`, 로컬 checksum을 교차 검사한다. `pnpm source:verify`는 원격 ref를 checkout해 원본 checksum과 commit도 확인한다.

`auto-pr`은 downstream 수정이 없는 외부 스킬에만 사용한다. `notify-only`는 로컬 수정이 있어 자동 덮어쓰기가 안전하지 않은 스킬, `internal`은 이 모노레포에서 직접 관리하는 스킬이다. 주간 `upstream-sync` workflow는 정확한 `vX.Y.Z` tag만 후보로 보고 스킬별 draft PR을 만든다. 더 높은 stable 버전 tag가 있으면 갱신 후보다. 버전이 같을 때는 tag로 고정한 항목의 tag가 다른 commit을 가리키거나, commit으로 고정한 항목의 commit에 그 tag가 붙은 경우만 후보다. commit으로 고정한 항목이 같은 버전의 tag와 다른 commit을 가리키면 어느 쪽이 최신인지 알 수 없으므로 자동으로 갱신하지 않고, 실행 요약의 `needs attention`과 report의 `attention`에 표시한다. 조회 오류가 난 `auto-pr` 항목도 같은 곳에 표시한다. 가져온 파일은 실행하지 않는다. 이 저장소에서는 Actions의 `GITHUB_TOKEN` Pull Request 생성 권한을 관리자가 수동으로 허용해야 한다. 그 token으로 만든 PR은 `pull_request` CI를 자동으로 발생시키지 않으므로, 검토자가 CI의 `workflow_dispatch`를 해당 PR branch에서 수동 실행한다.

플러그인 현재 버전의 단일 소스는 `release/version.json`이다. `pnpm release:sync -- --write`는 현재 버전 표면을 생성하고 `pnpm release:check`는 누락·중복 marker와 drift를 실패시킨다. 이 명령들은 tag, GitHub Release, marketplace 설치나 배포를 만들지 않는다.

## 업데이트 PR 검토

1. source lock의 tag, peeled commit과 checksum 변경을 확인한다.
2. 스킬의 계약·문서·테스트 변경을 검토한다.
3. 전체 저장소 검증과 원격 source 검증을 실행한다.
4. draft를 해제하고 병합할지는 사람이 결정한다. 자동 병합과 자동 릴리스는 사용하지 않는다.
