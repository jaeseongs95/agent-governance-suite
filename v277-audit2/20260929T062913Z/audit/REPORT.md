# AGS v2.7.7 재감사(D-1 반영분)

- 판정 대상: `claude/v277-utf8-framing` = `00b16e845ec02a94d9d6be7877f62987687e80c7` (tree `e36595c3b9caaaeed89f3bf30b94d4fa0573e36c`)
- 직전 감사: `fd3f486a` PASS_WITH_FINDINGS, evidence `v277-audit/20260929T055100Z` (D-1 minor 문서)
- writer 근거 `v277-utf8-fix1/20260929T061611Z`는 참고만 했다. 판정은 아래 직접 확인으로만 했다.
- 읽기 전용. 제품 소스는 바꾸지 않았다.

## 판정: PASS — 출시 차단 아님

D-1이 해소됐고, 새 문장 두 개는 코드와 반례에 맞는다. 새 오류나 과장은 없다.

## 1. 범위 — PASS (logs/scope-and-diff.txt)

- `fd3f486a`는 `00b16e84`의 조상이다(fast-forward). 커밋은 1개: `00b16e8 docs: correct the hook path exposure in the 2.7.7 notes`.
- 바뀐 파일은 `docs/release-notes-v2.7.7.md` 하나이고(+2/−2), 그 밖의 파일 변경은 0이다. 소스, 시험, dist, claude-plugin, 버전 파일은 그대로다.
- word diff상 바뀐 것은 피해 문단의 hook 문장(`:5`)과 호환성 문단의 요청 문장(`:13`) 두 곳뿐이다.

## 2. 새 문장 검증 — PASS

**피해 문단(`:5`):** "일반 텍스트 본문이면 응답이 16384 byte에 닿지 않습니다. 다만 제어 문자는 JSON에서 `\u0001`처럼 6 byte로 늘어나므로, 제어 문자가 많은 본문은 hook 경로에서도 응답이 16384 byte를 넘어 같은 결함을 겪을 수 있었습니다. 이번 수정은 이 경우도 고칩니다."

- **상한 계산(logs/text-bound.txt):** 4096 byte 본문, broker가 받는 가장 긴 identity(host 64, sessionId 200), hook 응답의 추가 필드를 모두 넣었다.

  | 본문 | 최악 hook claim 줄 | 최악 prepare 줄 |
  |---|---|---|
  | `"` / `\` / `\n` / `\t` / lone surrogate | 약 9.1 KB | 약 8.9 KB |
  | 한글 | 5.0 KB | 4.8 KB |
  | `\u0001` 2401개 | 17022 byte | 16846 byte |

  일반 텍스트의 escape는 최대 2배라 닿지 않는다. 6 byte escape 제어 문자가 약 2400개 이상일 때만 넘는다. 따라서 "일반 텍스트면 닿지 않음"과 "제어 문자가 많은 본문"이 모두 맞다.
- **반례 재실행(logs/hook-shape-probe.jsonl):** 00b16e84에서 hook 한도(`maxMessages: 1`, `maxBodyChars: 4096`)로 3/3 온전하다(응답 조각 [16384, 약 1055]). 직전 감사에서 9e76a07b는 같은 입력으로 3/3 깨졌다.
- "같은 결함을 겪을 수 있었습니다"는 가능성 표현이라 과장이 아니다. hook의 `claim-host-wake`, `claim-deferred`, `claim-turn-end`도 같은 `requestSessionMessageOnce` reader를 거치므로 hook 경로에도 해당한다.

**호환성 문단(`:13`):** "일반 텍스트 본문이면 16384 byte에 닿지 않습니다. 제어 문자가 많아 JSON escape로 크게 늘어나는 본문은 요청도 16384 byte를 넘을 수 있고, 이때는 이전 broker의 reader가 그대로 적용됩니다."

- 새 반례 probe(logs/request-shape-probe.jsonl): 00b16e84 client가 prepare 요청을 보냈다. 본문은 4088–4090 byte, 요청 줄은 17319–17321 byte다.

  | 한글이 16384에 걸린 위치 | v2.7.6 dist broker | 00b16e84 broker |
  |---|---|---|
  | 2 byte 앞 | 저장된 본문 깨짐(U+FFFD 2개) | 온전 |
  | 1 byte 앞 | 저장된 본문 깨짐(U+FFFD 3개) | 온전 |
  | 문자 경계(0) | 온전 | 온전 |

- 문장이 말하는 "이전 broker의 reader가 그대로 적용"이 실제로 저장 본문 손상으로 나타남을 확인했다. 알려진 한계 문단("이전 broker의 요청 reader도 … 그대로")과도 맞다.

**참고(finding 아님)**
- `\b \t \n \f \r`는 2 byte로 escape된다. 문장은 "`\u0001`처럼"이라는 예시로 6 byte 제어 문자를 가리키므로 오류는 아니다.
- 피해 문단의 첫 문장 "피해는 hook 없는 CLI claim 경로에서 났습니다"는 관측된 피해이고, 새 문장은 가능성이다. 서로 모순되지 않는다.

## 3. 다른 살아 있는 문서 — PASS (logs/living-docs-scan.txt)

- 대상: 00b16e84의 `*.md` 중 v2.7.6 이하 공개 notes를 뺀 문서.
- 검색어: `16384`, `16 KiB`, `닿지 않`, `닿기 어렵`, `hook 전달 경로`, `영향이 없었`, hook과 4096을 함께 쓴 문장.
- 같은 주장은 v2.7.7 notes에만 있고, 이미 고쳐졌다.
- `claude-overlay/README.md:51`과 `claude-plugin/README.md:51`은 "토큰이 서버에 닿지 않는다"는 무관한 문장이다. `docs/architecture.md:71`은 hook이 한 번에 한 메시지만 claim한다는 사실만 적고 16384 노출을 주장하지 않는다.
- `16384`를 담은 notes는 v2.7.7 하나뿐이다.

## 4. 검증 — PASS (00b16e84 깨끗한 worktree, Node v24.21.0; logs/verify-*.log)

| 단계 | 결과 |
|---|---|
| install --frozen-lockfile | 0 |
| bundle:check | 0 |
| lint | 0 |
| validate:all | 0 |
| claude:check | 0 (claude-plugin: fresh) |
| git diff --check (작업 트리 / fd3f486a..00b16e84) | 0 / 0 |
| 검증 뒤 작업 트리 변경 | 0 byte |

## NOT_RUN

- 전체 test, runtime:check, validate:official. 문서만 바뀌어 요청 범위에서 뺐다. 소스와 시험은 fd3f486a와 같고, 직전 감사에서 전체 검증을 마쳤다.
- Windows, CI, 실제 PC·설치 캐시, source:verify
- D-1 반례를 실제 `claim-host-wake` hook 호출로 보내는 것(같은 한도의 `claim`으로 대신함)
