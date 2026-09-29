| # | 입력(id) | 그룹 | 기대 | v53 관측 (rec/managed/msgs, 행 전→후, 새 claim, 새 wake행, 이후 reserve) | v53 판정 | v271 관측 (행 후, 이후 reserve) | v271 판정 |
|---|---|---|---|---|---|---|---|
| 1 | `control-valid-unknown` | control | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 2 | `control-valid-submitted` | control | accept-claim | true/true/1, submitted→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 3 | `control-valid-started` | control | accept-claim | true/true/1, started→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 4 | `obs:obs.host=claude-code` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 5 | `obs:obs.host missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 6 | `obs:obs.host=number` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 7 | `obs:obs.host=''` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 8 | `obs:obs.sessionId other` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 9 | `obs:obs.sessionId missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 10 | `obs:obs.sessionId=1MB` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 11 | `obs:obs.sessionId unicode` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 12 | `obs:obs.sessionId ctrl NUL` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 13 | `obs:obs.kind=turn-end` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 14 | `obs:obs.kind missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 15 | `obs:obs.wakeOnly=false` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 16 | `obs:obs.wakeOnly='true'` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 17 | `obs:obs.wakeOnly missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 18 | `obs:obs.actor.observedBy other host` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 19 | `obs:obs.actor.observedBy ''` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 20 | `obs:obs.actor.kind=subagent` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 21 | `obs:obs.actor.kind=unknown (digest differs)` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 22 | `obs:obs.actor.assurance=unknown (digest differs)` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 23 | `obs:obs.actor.assurance=verified` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 24 | `obs:obs.actor missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 25 | `obs:obs.actor=null` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 26 | `obs:obs.wakeCandidates other nonce` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 27 | `obs:obs.wakeCandidates +extra unregistered` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 28 | `obs:obs.wakeCandidates missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 29 | `obs:obs.wakeCandidates []` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 30 | `obs:obs.wakeCandidates string` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 31 | `obs:obs.wakeCandidates [number]` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 32 | `obs:obs.wakeCandidates ['']` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 33 | `obs:obs.wakeCandidates len129` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 34 | `obs:obs.wakeCandidates len21` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 35 | `obs:obs.wakeCandidates 11 items` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 36 | `obs:obs.wakeCandidates unicode suffix` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 37 | `obs:obs.wakeCandidates ctrl \n suffix` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 38 | `obs:obs.wakeCandidates case-flipped` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 39 | `obs:obs.wakeCandidates duplicate same nonce (digest set-equal)` | observation | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 40 | `obs:obs extra field ignored (digest subset)` | observation | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 41 | `obs=array [obs]` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 42 | `obs=null` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 43 | `obs=string` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 44 | `reader undefined` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 45 | `rid:receiptId=''` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 46 | `rid:receiptId other uuid` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 47 | `rid:receiptId flipped last char` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 48 | `rid:receiptId 1MB` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 49 | `rid:receiptId unicode` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 50 | `rid:receiptId ctrl NUL` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 51 | `rid:receiptId SQL-ish` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 52 | `rid:receiptId uppercased` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 53 | `broker:sourceReceiptId number` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 54 | `broker:sourceReceiptId null` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 55 | `broker:sourceReceiptId object` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 56 | `broker:sourceReceiptId array` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 57 | `broker:sourceReceiptId missing` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 58 | `broker:control valid (real clock)` | control | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 59 | `broker:target.host number` | receiptId-type | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=Error: Session identity is invalid. | PASS | unknown, post=false | PASS |
| 60 | `rec-nosign:host` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 61 | `rec-resign:host` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 62 | `rec-nosign:sessionId` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 63 | `rec-resign:sessionId` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 64 | `rec-nosign:contentDigest` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 65 | `rec-resign:contentDigest` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 66 | `rec-nosign:originKind=tool` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 67 | `rec-resign:originKind=tool` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 68 | `rec-nosign:authorityEffect=approve` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 69 | `rec-resign:authorityEffect=approve` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 70 | `rec-nosign:attestation.kind` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 71 | `rec-resign:attestation.kind` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 72 | `rec-nosign:attestation.adapter` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 73 | `rec-resign:attestation.adapter` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 74 | `rec-nosign:attestation.capabilityVersion` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 75 | `rec-resign:attestation.capabilityVersion` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 76 | `rec-nosign:observedAt future+60s` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 77 | `rec-resign:observedAt future+60s` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 78 | `rec-nosign:expiresAt past` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 79 | `rec-resign:expiresAt past` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 80 | `rec-nosign:expiresAt invalid string` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 81 | `rec-resign:expiresAt invalid string` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 82 | `rec-nosign:observedAt invalid string` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 83 | `rec-resign:observedAt invalid string` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 84 | `rec-resign:expiresAt extended +1h (key holder)` | receipt-resigned-tamper | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 85 | `rec-nosign:receiptId inside json` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 86 | `rec-resign:receiptId inside json (key holder)` | receipt-resigned-tamper | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 87 | `rec-nosign:integrityToken flipped` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 88 | `rec-nosign:integrityToken missing` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 89 | `rec-nosign:integrityToken number` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 90 | `rec-nosign:integrityToken truncated` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 91 | `rec:receipt_json corrupt (not JSON)` | receipt-unsigned-tamper | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot read the input source receipt. | PASS | unknown, post=false | PASS |
| 92 | `ttl:now=observedAt-1ms` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 93 | `ttl:now=observedAt exact` | ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 94 | `ttl:now=expiresAt-1ms (presence heartbeated)` | ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 95 | `ttl:now=expiresAt-1ms (presence lease lapsed)` | ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 96 | `ttl:now=expiresAt exact (presence heartbeated)` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 97 | `ttl:now=expiresAt exact` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 98 | `ttl:now=expiresAt+1ms` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 99 | `ttl:receipt issued in future (+60s) used now` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 100 | `rowttl:row expires_at-1ms` | row-ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 101 | `rowttl:row expires_at exact` | row-ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 102 | `rowttl:row expires_at+1ms` | row-ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 103 | `replay:same receipt twice` | replay | reject-nochange | false/false/0, observed→observed, claim=0, rows+0, post=false | PASS | observed, post=false | PASS |
| 104 | `replay:receipt of target A with target B obs` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 105 | `replay:A's nonce + A's receipt presented for target B` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 106 | `replay:A obs+receipt, target arg B (target/obs mismatch)` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 107 | `replay:receipt from a different trust DB (other key)` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 108 | `key:trust DB missing` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 109 | `key:trust signing key row deleted` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 110 | `key:different 32B key` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 111 | `key:corrupt key (16B)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 112 | `key:corrupt key (non-base64 text)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 113 | `key:trust DB file garbage` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 114 | `key:trust DB zero-length` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 115 | `key:trust DB newer schema (user_version 999)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Trust database schema is newer than this serv | PASS | unknown, post=false | PASS |
| 116 | `key:trust DB file read-only (0400)` | key | reject-any | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS* | observed, post=false | PASS* |
| 117 | `gen:new instance (new generation)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 118 | `gen:same instance restarted (new birth_generation)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 119 | `gen:transport differs (codex-deferred)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 120 | `gen:presence lease lapsed (unreachable, same gen)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 121 | `gen:presence ended (same gen)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 122 | `gen:no presence row` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 123 | `mixed:current + unregistered` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 124 | `mixed:current + legacy fresh` | mixed | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 125 | `mixed:current + legacy already consumed` | mixed | reject-any | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 126 | `mixed:current + legacy expired` | mixed | reject-any | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 127 | `mixed:current + already observed row` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 128 | `mixed:current + not-submitted row` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 129 | `mixed:current + other session's nonce` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 130 | `legacy:valid legacy marker` | legacy | reject-any | true/false/1, legacy→legacy, claim=1, rows+0, post=false | PASS* | legacy, post=false | PASS* |
