| # | prompt/입력 | 기대 block | v53 block | v53 행 전→후 | v53 판정 | v271 block | v271 행 후 |
|---|---|---|---|---|---|---|---|
| 1 | exact marker (control) | true | true | submitted→observed | PASS | false | observed |
| 2 | exact marker, unknown state | true | true | unknown→observed | PASS | false | observed |
| 3 | marker + trailing \n | true | true | submitted→observed | PASS | false | observed |
| 4 | marker + CRLF + marker (same) | true | true | submitted→observed | PASS | false | observed |
| 5 | leading/trailing spaces | true | true | submitted→observed | PASS | false | observed |
| 6 | marker + \t | true | true | submitted→observed | PASS | false | observed |
| 7 | marker + NBSP (U+00A0, trimmed by JS) | true | true | submitted→observed | PASS | false | observed |
| 8 | BOM + marker (U+FEFF, trimmed by JS) | true | true | submitted→observed | PASS | false | observed |
| 9 | marker + U+2028 (line sep, trimmed) | true | true | submitted→observed | PASS | false | observed |
| 10 | marker + ZWSP U+200B | false | false | submitted→submitted | PASS | false | submitted |
| 11 | marker + NUL | false | false | submitted→submitted | PASS | false | submitted |
| 12 | marker + ESC[0m | false | false | submitted→submitted | PASS | false | submitted |
| 13 | marker + lone CR + text | false | false | submitted→submitted | PASS | false | submitted |
| 14 | marker + \n + user text (mixed) | false | false | submitted→submitted | PASS | false | submitted |
| 15 | marker with extra ']' | false | false | submitted→submitted | PASS | false | submitted |
| 16 | uppercase prefix | false | false | submitted→submitted | PASS | false | submitted |
| 17 | fullwidth brackets | false | false | submitted→submitted | PASS | false | submitted |
| 18 | lookalike prefix (Cyrillic a) | false | false | submitted→submitted | PASS | false | submitted |
| 19 | unregistered nonce | false | false | submitted→submitted | PASS | false | submitted |
| 20 | other session's registered marker | false | false | submitted→submitted | PASS | false | submitted |
| 21 | empty prompt | false | false | submitted→submitted | PASS | false | submitted |
| 22 | whitespace-only prompt | false | false | submitted→submitted | PASS | false | submitted |
| 23 | prompt number | false | false | submitted→submitted | PASS | false | submitted |
| 24 | prompt missing | false | false | submitted→submitted | PASS | false | submitted |
| 25 | subagent (agent_id set) | false | false | submitted→submitted | PASS | false | submitted |
| 26 | hook_event_name=Stop | false | false | submitted→submitted | PASS | false | submitted |
| 27 | old generation marker (late) | false | false | submitted→observed(late) | PASS | false | unknown(late) |
| 28 | pending body (not empty) -> deliver | false | false | submitted→observed | PASS | false | observed |
| 29 | duplicate: second delivery of same marker | false | false | observed→observed | PASS | false | observed |
| 30 | claude-code host same state | false | false | submitted→observed | PASS | false | observed |
| 31 | malformed stdin JSON | false | false | submitted→submitted | PASS | false | submitted |
