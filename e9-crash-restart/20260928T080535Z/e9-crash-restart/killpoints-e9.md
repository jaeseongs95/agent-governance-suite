# Kill points e9

| id | mode | role | step | kill label (trace) | killed | restarts | a | b | c | d | e | f |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| e9-dk-000 | double(2nd@27) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @370 | Y | 2 | P | P | P | P | P | P |
| e9-dk-001 | double(2nd@31) | broker | S17-relay-D2 | `exec:pre/COMMIT` @573 | Y | 2 | P | P | P | P | P | P |
| e9-dk-002 | double(2nd@52) | broker | S18-hooks | `run:post/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery` @626 | Y | 2 | P | P | P | P | P | P |
| e9-dk-003 | double(2nd@13) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @436 | Y | 2 | P | P | P | P | P | P |
| e9-dk-004 | double(2nd@47) | broker | S04-reconcile-A | `exec:pre/BEGIN IMMEDIATE` @99 | Y | 2 | P | P | P | P | P | P |
| e9-dk-005 | double(2nd@28) | broker | S09-hooks | `exec:pre/BEGIN IMMEDIATE;` @255 | Y | 2 | P | P | P | P | P | P |
| e9-dk-006 | double(2nd@51) | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @220 | Y | 2 | P | P | P | P | P | P |
| e9-dk-007 | double(2nd@24) | broker | S04-reconcile-A | `exec:post/COMMIT` @116 | Y | 2 | P | P | P | P | P | P |
| e9-dk-008 | double(2nd@23) | broker | S14-relay-D1 | `exec:pre/COMMIT` @457 | Y | 2 | P | P | P | P | P | P |
| e9-dk-009 | double(2nd@44) | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @185 | Y | 2 | P | P | P | P | P | P |
| e9-dk-010 | double(2nd@9) | broker | S17-relay-D2 | `exec:pre/COMMIT` @589 | Y | 2 | P | P | P | P | P | P |
| e9-dk-011 | double(2nd@35) | broker | S14-relay-D1 | `exec:pre/COMMIT` @449 | Y | 2 | P | P | P | P | P | P |
| e9-dk-012 | double(2nd@35) | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @254 | Y | 2 | P | P | P | P | P | P |
| e9-dk-013 | double(2nd@28) | broker | S04-reconcile-A | `exec:pre/BEGIN IMMEDIATE` @99 | Y | 2 | P | P | P | P | P | P |
| e9-dk-014 | double(2nd@52) | broker | S04-reconcile-A | `run:post/UPDATE wake_nonces SET state = 'observed', observed_at = ?, c` @114 | Y | 2 | P | P | P | P | P | P |
| e9-dk-015 | double(2nd@6) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @464 | Y | 2 | P | P | P | P | P | P |
| e9-dk-016 | double(2nd@27) | broker | S04-reconcile-A | `exec:post/COMMIT` @116 | Y | 2 | P | P | P | P | P | P |
| e9-dk-017 | double(2nd@5) | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @401 | Y | 2 | P | P | P | P | P | P |
| e9-dk-018 | double(2nd@50) | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE` @244 | Y | 2 | P | P | P | P | P | P |
| e9-dk-019 | double(2nd@4) | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @235 | Y | 2 | P | P | P | P | P | P |
| e9-dk-020 | double(2nd@14) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @402 | Y | 2 | P | P | P | P | P | P |
| e9-dk-021 | double(2nd@7) | broker | S14-relay-D1 | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @448 | Y | 2 | P | P | P | P | P | P |
| e9-dk-022 | double(2nd@2) | broker | S09-hooks | `exec:pre/BEGIN IMMEDIATE;` @255 | Y | 2 | P | P | P | P | P | P |
| e9-dk-023 | double(2nd@12) | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @542 | Y | 2 | P | P | P | P | P | P |
| e9-dk-024 | double(2nd@44) | broker | S04-reconcile-A | `run:post/UPDATE wake_nonces SET state = 'observed', observed_at = ?, c` @114 | Y | 2 | P | P | P | P | P | P |
| e9-dk-025 | double(2nd@24) | broker | S09-hooks | `exec:pre/COMMIT` @273 | Y | 2 | P | P | P | P | P | P |
| e9-dk-026 | double(2nd@9) | broker | S04-reconcile-A | `exec:pre/BEGIN IMMEDIATE` @99 | Y | 2 | P | P | P | P | P | P |
| e9-dk-027 | double(2nd@51) | broker | S18-hooks | `exec:post/COMMIT;` @616 | Y | 2 | P | P | P | P | P | P |
| e9-dk-028 | double(2nd@20) | broker | S09-hooks | `exec:post/COMMIT;` @260 | Y | 2 | P | P | P | P | P | P |
| e9-dk-029 | double(2nd@6) | broker | S14-relay-D1 | `exec:pre/COMMIT` @449 | Y | 2 | P | P | P | P | P | P |
| e9-down-0 | outage-35s(down 35000ms) | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE` @244 | Y | 1 | P | **F** | P | P | P | P |
| e9-down-1 | outage-35s(down 35000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @464 | Y | 1 | P | **F** | P | P | P | P |
| e9-down-2 | outage-35s(down 35000ms) | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE` @600 | Y | 1 | P | **F** | P | P | P | P |
| e9-downctl-10s | outage-10s(down 10000ms) | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE` @244 | Y | 1 | P | P | P | P | P | P |
| e9-downctl-25s | outage-25s(down 25000ms) | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE` @244 | Y | 1 | P | P | P | P | P | P |
| e9-downctl-S16-10s | outage-10s(down 10000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @464 | Y | 1 | P | P | P | P | P | P |
| e9-downctl-S16-25s | outage-25s(down 25000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @464 | Y | 1 | P | P | P | P | P | P |
| e9-ev-000 | boundary | broker | S01-presence-A3 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @23 | Y | 1 | P | P | P | P | P | P |
| e9-ev-001 | boundary | broker | S01-presence-A3 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @24 | Y | 1 | P | P | P | P | P | P |
| e9-ev-002 | boundary | broker | S02-presence-B3 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @27 | Y | 1 | P | P | P | P | P | P |
| e9-ev-003 | boundary | broker | S02-presence-B3 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @28 | Y | 1 | P | P | P | P | P | P |
| e9-ev-004 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @31 | Y | 1 | P | P | P | P | P | P |
| e9-ev-005 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @32 | Y | 1 | P | P | P | P | P | P |
| e9-ev-006 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @33 | Y | 1 | P | P | P | P | P | P |
| e9-ev-007 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @34 | Y | 1 | P | P | P | P | P | P |
| e9-ev-008 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @35 | Y | 1 | P | P | P | P | P | P |
| e9-ev-009 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @36 | Y | 1 | P | P | P | P | P | P |
| e9-ev-010 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @37 | Y | 1 | P | P | P | P | P | P |
| e9-ev-011 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @38 | Y | 1 | P | P | P | P | P | P |
| e9-ev-012 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @39 | Y | 1 | P | P | P | P | P | P |
| e9-ev-013 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @40 | Y | 1 | P | P | P | P | P | P |
| e9-ev-014 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @41 | Y | 1 | P | P | P | P | P | P |
| e9-ev-015 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @42 | Y | 1 | P | P | P | P | P | P |
| e9-ev-016 | boundary | broker | S03-relay-A-latched | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @43 | Y | 1 | P | P | P | P | P | P |
| e9-ev-017 | boundary | broker | S03-relay-A-latched | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @44 | Y | 1 | P | P | P | P | P | P |
| e9-ev-018 | boundary | broker | S03-relay-A-latched | `exec:pre/BEGIN IMMEDIATE` @49 | Y | 1 | P | P | P | P | P | P |
| e9-ev-019 | boundary | broker | S03-relay-A-latched | `exec:post/BEGIN IMMEDIATE` @50 | Y | 1 | P | P | P | P | P | P |
| e9-ev-020 | boundary | broker | S03-relay-A-latched | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @55 | Y | 1 | P | P | P | P | P | P |
| e9-ev-021 | boundary | broker | S03-relay-A-latched | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @56 | Y | 1 | P | P | P | P | P | P |
| e9-ev-022 | boundary | broker | S03-relay-A-latched | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @59 | Y | 1 | P | P | P | P | P | P |
| e9-ev-023 | boundary | broker | S03-relay-A-latched | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @60 | Y | 1 | P | P | P | P | P | P |
| e9-ev-024 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @61 | Y | 1 | P | P | P | P | P | P |
| e9-ev-025 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @62 | Y | 1 | P | P | P | P | P | P |
| e9-ev-026 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @63 | Y | 1 | P | P | P | P | P | P |
| e9-ev-027 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @64 | Y | 1 | P | P | P | P | P | P |
| e9-ev-028 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @65 | Y | 1 | P | P | P | P | P | P |
| e9-ev-029 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @66 | Y | 1 | P | P | P | P | P | P |
| e9-ev-030 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @67 | Y | 1 | P | P | P | P | P | P |
| e9-ev-031 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @68 | Y | 1 | P | P | P | P | P | P |
| e9-ev-032 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @69 | Y | 1 | P | P | P | P | P | P |
| e9-ev-033 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @70 | Y | 1 | P | P | P | P | P | P |
| e9-ev-034 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @71 | Y | 1 | P | P | P | P | P | P |
| e9-ev-035 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @72 | Y | 1 | P | P | P | P | P | P |
| e9-ev-036 | boundary | broker | S03-relay-A-latched | `exec:pre/COMMIT` @75 | Y | 1 | P | P | P | P | P | P |
| e9-ev-037 | boundary | broker | S03-relay-A-latched | `exec:post/COMMIT` @76 | Y | 1 | P | P | P | P | P | P |
| e9-ev-038 | boundary | broker | S03-relay-A-latched | `exec:pre/BEGIN IMMEDIATE` @81 | Y | 1 | P | P | P | P | P | P |
| e9-ev-039 | boundary | broker | S03-relay-A-latched | `exec:post/BEGIN IMMEDIATE` @82 | Y | 1 | P | P | P | P | P | P |
| e9-ev-040 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @83 | Y | 1 | P | P | P | P | P | P |
| e9-ev-041 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @84 | Y | 1 | P | P | P | P | P | P |
| e9-ev-042 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @85 | Y | 1 | P | P | P | P | P | P |
| e9-ev-043 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @86 | Y | 1 | P | P | P | P | P | P |
| e9-ev-044 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @87 | Y | 1 | P | P | P | P | P | P |
| e9-ev-045 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @88 | Y | 1 | P | P | P | P | P | P |
| e9-ev-046 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @89 | Y | 1 | P | P | P | P | P | P |
| e9-ev-047 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @90 | Y | 1 | P | P | P | P | P | P |
| e9-ev-048 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @91 | Y | 1 | P | P | P | P | P | P |
| e9-ev-049 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @92 | Y | 1 | P | P | P | P | P | P |
| e9-ev-050 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @93 | Y | 1 | P | P | P | P | P | P |
| e9-ev-051 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @94 | Y | 1 | P | P | P | P | P | P |
| e9-ev-052 | boundary | broker | S03-relay-A-latched | `exec:pre/COMMIT` @97 | Y | 1 | P | P | P | P | P | P |
| e9-ev-053 | boundary | broker | S03-relay-A-latched | `exec:post/COMMIT` @98 | Y | 1 | P | P | P | P | P | P |
| e9-ev-054 | boundary | broker | S04-reconcile-A | `exec:pre/BEGIN IMMEDIATE` @99 | Y | 1 | P | P | P | P | P | P |
| e9-ev-055 | boundary | broker | S04-reconcile-A | `exec:post/BEGIN IMMEDIATE` @100 | Y | 1 | P | P | P | P | P | P |
| e9-ev-056 | boundary | broker | S04-reconcile-A | `run:pre/UPDATE wake_nonces SET state = 'observed', observed_at = ?, co` @113 | Y | 1 | P | P | P | P | P | P |
| e9-ev-057 | boundary | broker | S04-reconcile-A | `run:post/UPDATE wake_nonces SET state = 'observed', observed_at = ?, c` @114 | Y | 1 | P | P | P | P | P | P |
| e9-ev-058 | boundary | broker | S04-reconcile-A | `exec:pre/COMMIT` @115 | Y | 1 | P | P | P | P | P | P |
| e9-ev-059 | boundary | broker | S04-reconcile-A | `exec:post/COMMIT` @116 | Y | 1 | P | P | P | P | P | P |
| e9-ev-060 | boundary | broker | S05-reconcile-A-again | `exec:pre/BEGIN IMMEDIATE` @117 | Y | 1 | P | P | P | P | P | P |
| e9-ev-061 | boundary | broker | S05-reconcile-A-again | `exec:post/BEGIN IMMEDIATE` @118 | Y | 1 | P | P | P | P | P | P |
| e9-ev-062 | boundary | broker | S05-reconcile-A-again | `exec:pre/COMMIT` @121 | Y | 1 | P | P | P | P | P | P |
| e9-ev-063 | boundary | broker | S05-reconcile-A-again | `exec:post/COMMIT` @122 | Y | 1 | P | P | P | P | P | P |
| e9-ev-064 | boundary | broker | S06-reconcile-B-foreign | `exec:pre/BEGIN IMMEDIATE` @123 | Y | 1 | P | P | P | P | P | P |
| e9-ev-065 | boundary | broker | S06-reconcile-B-foreign | `exec:post/BEGIN IMMEDIATE` @124 | Y | 1 | P | P | P | P | P | P |
| e9-ev-066 | boundary | broker | S06-reconcile-B-foreign | `exec:pre/COMMIT` @127 | Y | 1 | P | P | P | P | P | P |
| e9-ev-067 | boundary | broker | S06-reconcile-B-foreign | `exec:post/COMMIT` @128 | Y | 1 | P | P | P | P | P | P |
| e9-ev-068 | boundary | broker | S07-reconcile-B-bogus | `exec:pre/BEGIN IMMEDIATE` @129 | Y | 1 | P | P | P | P | P | P |
| e9-ev-069 | boundary | broker | S07-reconcile-B-bogus | `exec:post/BEGIN IMMEDIATE` @130 | Y | 1 | P | P | P | P | P | P |
| e9-ev-070 | boundary | broker | S07-reconcile-B-bogus | `exec:pre/COMMIT` @133 | Y | 1 | P | P | P | P | P | P |
| e9-ev-071 | boundary | broker | S07-reconcile-B-bogus | `exec:post/COMMIT` @134 | Y | 1 | P | P | P | P | P | P |
| e9-ev-072 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @135 | Y | 1 | P | P | P | P | P | P |
| e9-ev-073 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @136 | Y | 1 | P | P | P | P | P | P |
| e9-ev-074 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @137 | Y | 1 | P | P | P | P | P | P |
| e9-ev-075 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @138 | Y | 1 | P | P | P | P | P | P |
| e9-ev-076 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @139 | Y | 1 | P | P | P | P | P | P |
| e9-ev-077 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @140 | Y | 1 | P | P | P | P | P | P |
| e9-ev-078 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @141 | Y | 1 | P | P | P | P | P | P |
| e9-ev-079 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @142 | Y | 1 | P | P | P | P | P | P |
| e9-ev-080 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @143 | Y | 1 | P | P | P | P | P | P |
| e9-ev-081 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @144 | Y | 1 | P | P | P | P | P | P |
| e9-ev-082 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @145 | Y | 1 | P | P | P | P | P | P |
| e9-ev-083 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @146 | Y | 1 | P | P | P | P | P | P |
| e9-ev-084 | boundary | broker | S08-relay-A | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @147 | Y | 1 | P | P | P | P | P | P |
| e9-ev-085 | boundary | broker | S08-relay-A | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @148 | Y | 1 | P | P | P | P | P | P |
| e9-ev-086 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @153 | Y | 1 | P | P | P | P | P | P |
| e9-ev-087 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @154 | Y | 1 | P | P | P | P | P | P |
| e9-ev-088 | boundary | broker | S08-relay-A | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @159 | Y | 1 | P | P | P | P | P | P |
| e9-ev-089 | boundary | broker | S08-relay-A | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @160 | Y | 1 | P | P | P | P | P | P |
| e9-ev-090 | boundary | broker | S08-relay-A | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @163 | Y | 1 | P | P | P | P | P | P |
| e9-ev-091 | boundary | broker | S08-relay-A | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @164 | Y | 1 | P | P | P | P | P | P |
| e9-ev-092 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @165 | Y | 1 | P | P | P | P | P | P |
| e9-ev-093 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @166 | Y | 1 | P | P | P | P | P | P |
| e9-ev-094 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @167 | Y | 1 | P | P | P | P | P | P |
| e9-ev-095 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @168 | Y | 1 | P | P | P | P | P | P |
| e9-ev-096 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @169 | Y | 1 | P | P | P | P | P | P |
| e9-ev-097 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @170 | Y | 1 | P | P | P | P | P | P |
| e9-ev-098 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @171 | Y | 1 | P | P | P | P | P | P |
| e9-ev-099 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @172 | Y | 1 | P | P | P | P | P | P |
| e9-ev-100 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @173 | Y | 1 | P | P | P | P | P | P |
| e9-ev-101 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @174 | Y | 1 | P | P | P | P | P | P |
| e9-ev-102 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @175 | Y | 1 | P | P | P | P | P | P |
| e9-ev-103 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @176 | Y | 1 | P | P | P | P | P | P |
| e9-ev-104 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @179 | Y | 1 | P | P | P | P | P | P |
| e9-ev-105 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @180 | Y | 1 | P | P | P | P | P | P |
| e9-ev-106 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @185 | Y | 1 | P | P | P | P | P | P |
| e9-ev-107 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @186 | Y | 1 | P | P | P | P | P | P |
| e9-ev-108 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @187 | Y | 1 | P | P | P | P | P | P |
| e9-ev-109 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @188 | Y | 1 | P | P | P | P | P | P |
| e9-ev-110 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @189 | Y | 1 | P | P | P | P | P | P |
| e9-ev-111 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @190 | Y | 1 | P | P | P | P | P | P |
| e9-ev-112 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @191 | Y | 1 | P | P | P | P | P | P |
| e9-ev-113 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @192 | Y | 1 | P | P | P | P | P | P |
| e9-ev-114 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @193 | Y | 1 | P | P | P | P | P | P |
| e9-ev-115 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @194 | Y | 1 | P | P | P | P | P | P |
| e9-ev-116 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @195 | Y | 1 | P | P | P | P | P | P |
| e9-ev-117 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @196 | Y | 1 | P | P | P | P | P | P |
| e9-ev-118 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @197 | Y | 1 | P | P | P | P | P | P |
| e9-ev-119 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @198 | Y | 1 | P | P | P | P | P | P |
| e9-ev-120 | boundary | broker | S08-relay-A | `run:pre/INSERT INTO wake_nonces (nonce_digest, host, session_id, expir` @215 | Y | 1 | P | P | P | P | P | P |
| e9-ev-121 | boundary | broker | S08-relay-A | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @216 | Y | 1 | P | P | P | P | P | P |
| e9-ev-122 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @217 | Y | 1 | P | P | P | P | P | P |
| e9-ev-123 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @218 | Y | 1 | P | P | P | P | P | P |
| e9-ev-124 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @219 | Y | 1 | P | P | P | P | P | P |
| e9-ev-125 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @220 | Y | 1 | P | P | P | P | P | P |
| e9-ev-126 | boundary | broker | S08-relay-A | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @231 | Y | 1 | P | P | P | P | P | P |
| e9-ev-127 | boundary | broker | S08-relay-A | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @232 | Y | 1 | P | P | P | P | P | P |
| e9-ev-128 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @233 | Y | 1 | P | P | P | P | P | P |
| e9-ev-129 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @234 | Y | 1 | P | P | P | P | P | P |
| e9-ev-130 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @235 | Y | 1 | P | P | P | P | P | P |
| e9-ev-131 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @236 | Y | 1 | P | P | P | P | P | P |
| e9-ev-132 | boundary | broker | S08-relay-A | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @239 | Y | 1 | P | P | P | P | P | P |
| e9-ev-133 | boundary | broker | S08-relay-A | `run:post/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_b` @240 | Y | 1 | P | P | P | P | P | P |
| e9-ev-134 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @241 | Y | 1 | P | P | P | P | P | P |
| e9-ev-135 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @242 | Y | 1 | P | P | P | P | P | P |
| e9-ev-136 | boundary | broker | S09-hooks | `exec:pre/BEGIN IMMEDIATE` @243 | Y | 1 | P | P | P | P | P | P |
| e9-ev-137 | boundary | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE` @244 | Y | 1 | P | P | P | P | P | P |
| e9-ev-138 | boundary | broker | S09-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @253 | Y | 1 | P | P | P | P | P | P |
| e9-ev-139 | boundary | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @254 | Y | 1 | P | P | P | P | P | P |
| e9-ev-140 | boundary | broker | S09-hooks | `exec:pre/BEGIN IMMEDIATE;` @255 | Y | 1 | P | P | P | P | P | P |
| e9-ev-141 | boundary | broker | S09-hooks | `exec:post/BEGIN IMMEDIATE;` @256 | Y | 1 | P | P | P | P | P | P |
| e9-ev-142 | boundary | broker | S09-hooks | `exec:pre/COMMIT;` @259 | Y | 1 | P | P | P | P | P | P |
| e9-ev-143 | boundary | broker | S09-hooks | `exec:post/COMMIT;` @260 | Y | 1 | P | P | P | P | P | P |
| e9-ev-144 | boundary | broker | S09-hooks | `run:pre/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_` @269 | Y | 1 | P | P | P | P | P | P |
| e9-ev-145 | boundary | broker | S09-hooks | `run:post/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery` @270 | Y | 1 | P | P | P | P | P | P |
| e9-ev-146 | boundary | broker | S09-hooks | `run:pre/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, ob` @271 | Y | 1 | P | P | P | P | P | P |
| e9-ev-147 | boundary | broker | S09-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @272 | Y | 1 | P | P | P | P | P | P |
| e9-ev-148 | boundary | broker | S09-hooks | `exec:pre/COMMIT` @273 | Y | 1 | P | P | P | P | P | P |
| e9-ev-149 | boundary | broker | S09-hooks | `exec:post/COMMIT` @274 | Y | 1 | P | P | P | P | P | P |
| e9-ev-150 | boundary | broker | S10-ack-A | `exec:pre/BEGIN IMMEDIATE` @275 | Y | 1 | P | P | P | P | P | P |
| e9-ev-151 | boundary | broker | S10-ack-A | `exec:post/BEGIN IMMEDIATE` @276 | Y | 1 | P | P | P | P | P | P |
| e9-ev-152 | boundary | broker | S10-ack-A | `run:pre/UPDATE messages SET acknowledged_at = ?, claim_until = NULL WH` @277 | Y | 1 | P | P | P | P | P | P |
| e9-ev-153 | boundary | broker | S10-ack-A | `run:post/UPDATE messages SET acknowledged_at = ?, claim_until = NULL W` @278 | Y | 1 | P | P | P | P | P | P |
| e9-ev-154 | boundary | broker | S10-ack-A | `exec:pre/COMMIT` @279 | Y | 1 | P | P | P | P | P | P |
| e9-ev-155 | boundary | broker | S10-ack-A | `exec:post/COMMIT` @280 | Y | 1 | P | P | P | P | P | P |
| e9-ev-156 | boundary | broker | S11-presence-D1 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @281 | Y | 1 | P | P | P | P | P | P |
| e9-ev-157 | boundary | broker | S11-presence-D1 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @282 | Y | 1 | P | P | P | P | P | P |
| e9-ev-158 | boundary | broker | S12-prepare-D | `exec:pre/BEGIN IMMEDIATE` @285 | Y | 1 | P | P | P | P | P | P |
| e9-ev-159 | boundary | broker | S12-prepare-D | `exec:post/BEGIN IMMEDIATE` @286 | Y | 1 | P | P | P | P | P | P |
| e9-ev-160 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @287 | Y | 1 | P | P | P | P | P | P |
| e9-ev-161 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @288 | Y | 1 | P | P | P | P | P | P |
| e9-ev-162 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @289 | Y | 1 | P | P | P | P | P | P |
| e9-ev-163 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @290 | Y | 1 | P | P | P | P | P | P |
| e9-ev-164 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @291 | Y | 1 | P | P | P | P | P | P |
| e9-ev-165 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @292 | Y | 1 | P | P | P | P | P | P |
| e9-ev-166 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @293 | Y | 1 | P | P | P | P | P | P |
| e9-ev-167 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @294 | Y | 1 | P | P | P | P | P | P |
| e9-ev-168 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @295 | Y | 1 | P | P | P | P | P | P |
| e9-ev-169 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @296 | Y | 1 | P | P | P | P | P | P |
| e9-ev-170 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @297 | Y | 1 | P | P | P | P | P | P |
| e9-ev-171 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @298 | Y | 1 | P | P | P | P | P | P |
| e9-ev-172 | boundary | broker | S12-prepare-D | `run:pre/INSERT INTO prepared_messages (message_id, sender_host, sender` @305 | Y | 1 | P | P | P | P | P | P |
| e9-ev-173 | boundary | broker | S12-prepare-D | `run:post/INSERT INTO prepared_messages (message_id, sender_host, sende` @306 | Y | 1 | P | P | P | P | P | P |
| e9-ev-174 | boundary | broker | S12-prepare-D | `exec:pre/COMMIT` @307 | Y | 1 | P | P | P | P | P | P |
| e9-ev-175 | boundary | broker | S12-prepare-D | `exec:post/COMMIT` @308 | Y | 1 | P | P | P | P | P | P |
| e9-ev-176 | boundary | broker | S13-send-D | `exec:pre/BEGIN IMMEDIATE` @309 | Y | 1 | P | P | P | P | P | P |
| e9-ev-177 | boundary | broker | S13-send-D | `exec:post/BEGIN IMMEDIATE` @310 | Y | 1 | P | P | P | P | P | P |
| e9-ev-178 | boundary | broker | S13-send-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @311 | Y | 1 | P | P | P | P | P | P |
| e9-ev-179 | boundary | broker | S13-send-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @312 | Y | 1 | P | P | P | P | P | P |
| e9-ev-180 | boundary | broker | S13-send-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @313 | Y | 1 | P | P | P | P | P | P |
| e9-ev-181 | boundary | broker | S13-send-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @314 | Y | 1 | P | P | P | P | P | P |
| e9-ev-182 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @315 | Y | 1 | P | P | P | P | P | P |
| e9-ev-183 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @316 | Y | 1 | P | P | P | P | P | P |
| e9-ev-184 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @317 | Y | 1 | P | P | P | P | P | P |
| e9-ev-185 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @318 | Y | 1 | P | P | P | P | P | P |
| e9-ev-186 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @319 | Y | 1 | P | P | P | P | P | P |
| e9-ev-187 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @320 | Y | 1 | P | P | P | P | P | P |
| e9-ev-188 | boundary | broker | S13-send-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @321 | Y | 1 | P | P | P | P | P | P |
| e9-ev-189 | boundary | broker | S13-send-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @322 | Y | 1 | P | P | P | P | P | P |
| e9-ev-190 | boundary | broker | S13-send-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @327 | Y | 1 | P | P | P | P | P | P |
| e9-ev-191 | boundary | broker | S13-send-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @328 | Y | 1 | P | P | P | P | P | P |
| e9-ev-192 | boundary | broker | S13-send-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @329 | Y | 1 | P | P | P | P | P | P |
| e9-ev-193 | boundary | broker | S13-send-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @330 | Y | 1 | P | P | P | P | P | P |
| e9-ev-194 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @331 | Y | 1 | P | P | P | P | P | P |
| e9-ev-195 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @332 | Y | 1 | P | P | P | P | P | P |
| e9-ev-196 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @333 | Y | 1 | P | P | P | P | P | P |
| e9-ev-197 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @334 | Y | 1 | P | P | P | P | P | P |
| e9-ev-198 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @335 | Y | 1 | P | P | P | P | P | P |
| e9-ev-199 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @336 | Y | 1 | P | P | P | P | P | P |
| e9-ev-200 | boundary | broker | S13-send-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @337 | Y | 1 | P | P | P | P | P | P |
| e9-ev-201 | boundary | broker | S13-send-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @338 | Y | 1 | P | P | P | P | P | P |
| e9-ev-202 | boundary | broker | S13-send-D | `run:pre/INSERT INTO messages ( message_id, sender_host, sender_session` @343 | Y | 1 | P | P | P | P | P | P |
| e9-ev-203 | boundary | broker | S13-send-D | `run:post/INSERT INTO messages ( message_id, sender_host, sender_sessio` @344 | Y | 1 | P | P | P | P | P | P |
| e9-ev-204 | boundary | broker | S13-send-D | `run:pre/UPDATE prepared_messages SET body = NULL, receipt = ?, expires` @347 | Y | 1 | P | P | P | P | P | P |
| e9-ev-205 | boundary | broker | S13-send-D | `run:post/UPDATE prepared_messages SET body = NULL, receipt = ?, expire` @348 | Y | 1 | P | P | P | P | P | P |
| e9-ev-206 | boundary | broker | S13-send-D | `exec:pre/COMMIT` @349 | Y | 1 | P | P | P | P | P | P |
| e9-ev-207 | boundary | broker | S13-send-D | `exec:post/COMMIT` @350 | Y | 1 | P | P | P | P | P | P |
| e9-ev-208 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @351 | Y | 1 | P | P | P | P | P | P |
| e9-ev-209 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @352 | Y | 1 | P | P | P | P | P | P |
| e9-ev-210 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @353 | Y | 1 | P | P | P | P | P | P |
| e9-ev-211 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @354 | Y | 1 | P | P | P | P | P | P |
| e9-ev-212 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @355 | Y | 1 | P | P | P | P | P | P |
| e9-ev-213 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @356 | Y | 1 | P | P | P | P | P | P |
| e9-ev-214 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @357 | Y | 1 | P | P | P | P | P | P |
| e9-ev-215 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @358 | Y | 1 | P | P | P | P | P | P |
| e9-ev-216 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @359 | Y | 1 | P | P | P | P | P | P |
| e9-ev-217 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @360 | Y | 1 | P | P | P | P | P | P |
| e9-ev-218 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @361 | Y | 1 | P | P | P | P | P | P |
| e9-ev-219 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @362 | Y | 1 | P | P | P | P | P | P |
| e9-ev-220 | boundary | broker | S14-relay-D1 | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @363 | Y | 1 | P | P | P | P | P | P |
| e9-ev-221 | boundary | broker | S14-relay-D1 | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @364 | Y | 1 | P | P | P | P | P | P |
| e9-ev-222 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @369 | Y | 1 | P | P | P | P | P | P |
| e9-ev-223 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @370 | Y | 1 | P | P | P | P | P | P |
| e9-ev-224 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @375 | Y | 1 | P | P | P | P | P | P |
| e9-ev-225 | boundary | broker | S14-relay-D1 | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @376 | Y | 1 | P | P | P | P | P | P |
| e9-ev-226 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @379 | Y | 1 | P | P | P | P | P | P |
| e9-ev-227 | boundary | broker | S14-relay-D1 | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @380 | Y | 1 | P | P | P | P | P | P |
| e9-ev-228 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @381 | Y | 1 | P | P | P | P | P | P |
| e9-ev-229 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @382 | Y | 1 | P | P | P | P | P | P |
| e9-ev-230 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @383 | Y | 1 | P | P | P | P | P | P |
| e9-ev-231 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @384 | Y | 1 | P | P | P | P | P | P |
| e9-ev-232 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @385 | Y | 1 | P | P | P | P | P | P |
| e9-ev-233 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @386 | Y | 1 | P | P | P | P | P | P |
| e9-ev-234 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @387 | Y | 1 | P | P | P | P | P | P |
| e9-ev-235 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @388 | Y | 1 | P | P | P | P | P | P |
| e9-ev-236 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @389 | Y | 1 | P | P | P | P | P | P |
| e9-ev-237 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @390 | Y | 1 | P | P | P | P | P | P |
| e9-ev-238 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @391 | Y | 1 | P | P | P | P | P | P |
| e9-ev-239 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @392 | Y | 1 | P | P | P | P | P | P |
| e9-ev-240 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @395 | Y | 1 | P | P | P | P | P | P |
| e9-ev-241 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @396 | Y | 1 | P | P | P | P | P | P |
| e9-ev-242 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @401 | Y | 1 | P | P | P | P | P | P |
| e9-ev-243 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @402 | Y | 1 | P | P | P | P | P | P |
| e9-ev-244 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @403 | Y | 1 | P | P | P | P | P | P |
| e9-ev-245 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @404 | Y | 1 | P | P | P | P | P | P |
| e9-ev-246 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @405 | Y | 1 | P | P | P | P | P | P |
| e9-ev-247 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @406 | Y | 1 | P | P | P | P | P | P |
| e9-ev-248 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @407 | Y | 1 | P | P | P | P | P | P |
| e9-ev-249 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @408 | Y | 1 | P | P | P | P | P | P |
| e9-ev-250 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @409 | Y | 1 | P | P | P | P | P | P |
| e9-ev-251 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @410 | Y | 1 | P | P | P | P | P | P |
| e9-ev-252 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @411 | Y | 1 | P | P | P | P | P | P |
| e9-ev-253 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @412 | Y | 1 | P | P | P | P | P | P |
| e9-ev-254 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @413 | Y | 1 | P | P | P | P | P | P |
| e9-ev-255 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @414 | Y | 1 | P | P | P | P | P | P |
| e9-ev-256 | boundary | broker | S14-relay-D1 | `run:pre/INSERT INTO wake_nonces (nonce_digest, host, session_id, expir` @431 | Y | 1 | P | P | P | P | P | P |
| e9-ev-257 | boundary | broker | S14-relay-D1 | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @432 | Y | 1 | P | P | P | P | P | P |
| e9-ev-258 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @433 | Y | 1 | P | P | P | P | P | P |
| e9-ev-259 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @434 | Y | 1 | P | P | P | P | P | P |
| e9-ev-260 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @435 | Y | 1 | P | P | P | P | P | P |
| e9-ev-261 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @436 | Y | 1 | P | P | P | P | P | P |
| e9-ev-262 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @447 | Y | 1 | P | P | P | P | P | P |
| e9-ev-263 | boundary | broker | S14-relay-D1 | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @448 | Y | 1 | P | P | P | P | P | P |
| e9-ev-264 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @449 | Y | 1 | P | P | P | P | P | P |
| e9-ev-265 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @450 | Y | 1 | P | P | P | P | P | P |
| e9-ev-266 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @451 | Y | 1 | P | P | P | P | P | P |
| e9-ev-267 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @452 | Y | 1 | P | P | P | P | P | P |
| e9-ev-268 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @455 | Y | 1 | P | P | P | P | P | P |
| e9-ev-269 | boundary | broker | S14-relay-D1 | `run:post/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_b` @456 | Y | 1 | P | P | P | P | P | P |
| e9-ev-270 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @457 | Y | 1 | P | P | P | P | P | P |
| e9-ev-271 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @458 | Y | 1 | P | P | P | P | P | P |
| e9-ev-272 | boundary | broker | S15-presence-D2 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @459 | Y | 1 | P | P | P | P | P | P |
| e9-ev-273 | boundary | broker | S15-presence-D2 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @460 | Y | 1 | P | P | P | P | P | P |
| e9-ev-274 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE` @463 | Y | 1 | P | P | P | P | P | P |
| e9-ev-275 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @464 | Y | 1 | P | P | P | P | P | P |
| e9-ev-276 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @473 | Y | 1 | P | P | P | P | P | P |
| e9-ev-277 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @474 | Y | 1 | P | P | P | P | P | P |
| e9-ev-278 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @475 | Y | 1 | P | P | P | P | P | P |
| e9-ev-279 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @476 | Y | 1 | P | P | P | P | P | P |
| e9-ev-280 | boundary | broker | S16-hooks | `exec:pre/COMMIT;` @479 | Y | 1 | P | P | P | P | P | P |
| e9-ev-281 | boundary | broker | S16-hooks | `exec:post/COMMIT;` @480 | Y | 1 | P | P | P | P | P | P |
| e9-ev-282 | boundary | broker | S16-hooks | `run:pre/UPDATE wake_nonces SET late_observed_at = coalesce(late_observ` @487 | Y | 1 | P | P | P | P | P | P |
| e9-ev-283 | boundary | broker | S16-hooks | `run:post/UPDATE wake_nonces SET late_observed_at = coalesce(late_obser` @488 | Y | 1 | P | P | P | P | P | P |
| e9-ev-284 | boundary | broker | S16-hooks | `exec:pre/COMMIT` @489 | Y | 1 | P | P | P | P | P | P |
| e9-ev-285 | boundary | broker | S16-hooks | `exec:post/COMMIT` @490 | Y | 1 | P | P | P | P | P | P |
| e9-ev-286 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @491 | Y | 1 | P | P | P | P | P | P |
| e9-ev-287 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @492 | Y | 1 | P | P | P | P | P | P |
| e9-ev-288 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @493 | Y | 1 | P | P | P | P | P | P |
| e9-ev-289 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @494 | Y | 1 | P | P | P | P | P | P |
| e9-ev-290 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @495 | Y | 1 | P | P | P | P | P | P |
| e9-ev-291 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @496 | Y | 1 | P | P | P | P | P | P |
| e9-ev-292 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @497 | Y | 1 | P | P | P | P | P | P |
| e9-ev-293 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @498 | Y | 1 | P | P | P | P | P | P |
| e9-ev-294 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @499 | Y | 1 | P | P | P | P | P | P |
| e9-ev-295 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @500 | Y | 1 | P | P | P | P | P | P |
| e9-ev-296 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @501 | Y | 1 | P | P | P | P | P | P |
| e9-ev-297 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @502 | Y | 1 | P | P | P | P | P | P |
| e9-ev-298 | boundary | broker | S17-relay-D2 | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @503 | Y | 1 | P | P | P | P | P | P |
| e9-ev-299 | boundary | broker | S17-relay-D2 | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @504 | Y | 1 | P | P | P | P | P | P |
| e9-ev-300 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @509 | Y | 1 | P | P | P | P | P | P |
| e9-ev-301 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @510 | Y | 1 | P | P | P | P | P | P |
| e9-ev-302 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @515 | Y | 1 | P | P | P | P | P | P |
| e9-ev-303 | boundary | broker | S17-relay-D2 | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @516 | Y | 1 | P | P | P | P | P | P |
| e9-ev-304 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @519 | Y | 1 | P | P | P | P | P | P |
| e9-ev-305 | boundary | broker | S17-relay-D2 | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @520 | Y | 1 | P | P | P | P | P | P |
| e9-ev-306 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @521 | Y | 1 | P | P | P | P | P | P |
| e9-ev-307 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @522 | Y | 1 | P | P | P | P | P | P |
| e9-ev-308 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @523 | Y | 1 | P | P | P | P | P | P |
| e9-ev-309 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @524 | Y | 1 | P | P | P | P | P | P |
| e9-ev-310 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @525 | Y | 1 | P | P | P | P | P | P |
| e9-ev-311 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @526 | Y | 1 | P | P | P | P | P | P |
| e9-ev-312 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @527 | Y | 1 | P | P | P | P | P | P |
| e9-ev-313 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @528 | Y | 1 | P | P | P | P | P | P |
| e9-ev-314 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @529 | Y | 1 | P | P | P | P | P | P |
| e9-ev-315 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @530 | Y | 1 | P | P | P | P | P | P |
| e9-ev-316 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @531 | Y | 1 | P | P | P | P | P | P |
| e9-ev-317 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @532 | Y | 1 | P | P | P | P | P | P |
| e9-ev-318 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @535 | Y | 1 | P | P | P | P | P | P |
| e9-ev-319 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @536 | Y | 1 | P | P | P | P | P | P |
| e9-ev-320 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @541 | Y | 1 | P | P | P | P | P | P |
| e9-ev-321 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @542 | Y | 1 | P | P | P | P | P | P |
| e9-ev-322 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @543 | Y | 1 | P | P | P | P | P | P |
| e9-ev-323 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @544 | Y | 1 | P | P | P | P | P | P |
| e9-ev-324 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @545 | Y | 1 | P | P | P | P | P | P |
| e9-ev-325 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @546 | Y | 1 | P | P | P | P | P | P |
| e9-ev-326 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @547 | Y | 1 | P | P | P | P | P | P |
| e9-ev-327 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @548 | Y | 1 | P | P | P | P | P | P |
| e9-ev-328 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @549 | Y | 1 | P | P | P | P | P | P |
| e9-ev-329 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @550 | Y | 1 | P | P | P | P | P | P |
| e9-ev-330 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @551 | Y | 1 | P | P | P | P | P | P |
| e9-ev-331 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @552 | Y | 1 | P | P | P | P | P | P |
| e9-ev-332 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @553 | Y | 1 | P | P | P | P | P | P |
| e9-ev-333 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @554 | Y | 1 | P | P | P | P | P | P |
| e9-ev-334 | boundary | broker | S17-relay-D2 | `run:pre/INSERT INTO wake_nonces (nonce_digest, host, session_id, expir` @571 | Y | 1 | P | P | P | P | P | P |
| e9-ev-335 | boundary | broker | S17-relay-D2 | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @572 | Y | 1 | P | P | P | P | P | P |
| e9-ev-336 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @573 | Y | 1 | P | P | P | P | P | P |
| e9-ev-337 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @574 | Y | 1 | P | P | P | P | P | P |
| e9-ev-338 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @575 | Y | 1 | P | P | P | P | P | P |
| e9-ev-339 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @576 | Y | 1 | P | P | P | P | P | P |
| e9-ev-340 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @587 | Y | 1 | P | P | P | P | P | P |
| e9-ev-341 | boundary | broker | S17-relay-D2 | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @588 | Y | 1 | P | P | P | P | P | P |
| e9-ev-342 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @589 | Y | 1 | P | P | P | P | P | P |
| e9-ev-343 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @590 | Y | 1 | P | P | P | P | P | P |
| e9-ev-344 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @591 | Y | 1 | P | P | P | P | P | P |
| e9-ev-345 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @592 | Y | 1 | P | P | P | P | P | P |
| e9-ev-346 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @595 | Y | 1 | P | P | P | P | P | P |
| e9-ev-347 | boundary | broker | S17-relay-D2 | `run:post/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_b` @596 | Y | 1 | P | P | P | P | P | P |
| e9-ev-348 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @597 | Y | 1 | P | P | P | P | P | P |
| e9-ev-349 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @598 | Y | 1 | P | P | P | P | P | P |
| e9-ev-350 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE` @599 | Y | 1 | P | P | P | P | P | P |
| e9-ev-351 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE` @600 | Y | 1 | P | P | P | P | P | P |
| e9-ev-352 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @609 | Y | 1 | P | P | P | P | P | P |
| e9-ev-353 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @610 | Y | 1 | P | P | P | P | P | P |
| e9-ev-354 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @611 | Y | 1 | P | P | P | P | P | P |
| e9-ev-355 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @612 | Y | 1 | P | P | P | P | P | P |
| e9-ev-356 | boundary | broker | S18-hooks | `exec:pre/COMMIT;` @615 | Y | 1 | P | P | P | P | P | P |
| e9-ev-357 | boundary | broker | S18-hooks | `exec:post/COMMIT;` @616 | Y | 1 | P | P | P | P | P | P |
| e9-ev-358 | boundary | broker | S18-hooks | `run:pre/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_` @625 | Y | 1 | P | P | P | P | P | P |
| e9-ev-359 | boundary | broker | S18-hooks | `run:post/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery` @626 | Y | 1 | P | P | P | P | P | P |
| e9-ev-360 | boundary | broker | S18-hooks | `run:pre/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, ob` @627 | Y | 1 | P | P | P | P | P | P |
| e9-ev-361 | boundary | broker | S18-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @628 | Y | 1 | P | P | P | P | P | P |
| e9-ev-362 | boundary | broker | S18-hooks | `exec:pre/COMMIT` @629 | Y | 1 | P | P | P | P | P | P |
| e9-ev-363 | boundary | broker | S18-hooks | `exec:post/COMMIT` @630 | Y | 1 | P | P | P | P | P | P |
| e9-ev-364 | boundary | broker | S19-ack-D | `exec:pre/BEGIN IMMEDIATE` @631 | Y | 1 | P | P | P | P | P | P |
| e9-ev-365 | boundary | broker | S19-ack-D | `exec:post/BEGIN IMMEDIATE` @632 | Y | 1 | P | P | P | P | P | P |
| e9-ev-366 | boundary | broker | S19-ack-D | `run:pre/UPDATE messages SET acknowledged_at = ?, claim_until = NULL WH` @633 | Y | 1 | P | P | P | P | P | P |
| e9-ev-367 | boundary | broker | S19-ack-D | `run:post/UPDATE messages SET acknowledged_at = ?, claim_until = NULL W` @634 | Y | 1 | P | P | P | P | P | P |
| e9-ev-368 | boundary | broker | S19-ack-D | `exec:pre/COMMIT` @635 | Y | 1 | P | P | P | P | P | P |
| e9-ev-369 | boundary | broker | S19-ack-D | `exec:post/COMMIT` @636 | Y | 1 | P | P | P | P | P | P |
| e9-ev-370 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @637 | Y | 1 | P | P | P | P | P | P |
| e9-ev-371 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @638 | Y | 1 | P | P | P | P | P | P |
| e9-ev-372 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @639 | Y | 1 | P | P | P | P | P | P |
| e9-ev-373 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @640 | Y | 1 | P | P | P | P | P | P |
| e9-ev-374 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @641 | Y | 1 | P | P | P | P | P | P |
| e9-ev-375 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @642 | Y | 1 | P | P | P | P | P | P |
| e9-ev-376 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @643 | Y | 1 | P | P | P | P | P | P |
| e9-ev-377 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @644 | Y | 1 | P | P | P | P | P | P |
| e9-ev-378 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @645 | Y | 1 | P | P | P | P | P | P |
| e9-ev-379 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @646 | Y | 1 | P | P | P | P | P | P |
| e9-ev-380 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @647 | Y | 1 | P | P | P | P | P | P |
| e9-ev-381 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @648 | Y | 1 | P | P | P | P | P | P |
| e9-ev-382 | boundary | broker | S20-relay-final | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @649 | Y | 1 | P | P | P | P | P | P |
| e9-ev-383 | boundary | broker | S20-relay-final | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @650 | Y | 1 | P | P | P | P | P | P |
| e9-ev-384 | boundary | broker | S20-relay-final | `exec:pre/BEGIN IMMEDIATE` @655 | Y | 1 | P | P | P | P | P | P |
| e9-ev-385 | boundary | broker | S20-relay-final | `exec:post/BEGIN IMMEDIATE` @656 | Y | 1 | P | P | P | P | P | P |
| e9-ev-386 | boundary | broker | S20-relay-final | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @661 | Y | 1 | P | P | P | P | P | P |
| e9-ev-387 | boundary | broker | S20-relay-final | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @662 | Y | 1 | P | P | P | P | P | P |
| e9-ev-388 | boundary | broker | S20-relay-final | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @665 | Y | 1 | P | P | P | P | P | P |
| e9-ev-389 | boundary | broker | S20-relay-final | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @666 | Y | 1 | P | P | P | P | P | P |
| e9-ev-390 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @667 | Y | 1 | P | P | P | P | P | P |
| e9-ev-391 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @668 | Y | 1 | P | P | P | P | P | P |
| e9-ev-392 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @669 | Y | 1 | P | P | P | P | P | P |
| e9-ev-393 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @670 | Y | 1 | P | P | P | P | P | P |
| e9-ev-394 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @671 | Y | 1 | P | P | P | P | P | P |
| e9-ev-395 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @672 | Y | 1 | P | P | P | P | P | P |
| e9-ev-396 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @673 | Y | 1 | P | P | P | P | P | P |
| e9-ev-397 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @674 | Y | 1 | P | P | P | P | P | P |
| e9-ev-398 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @675 | Y | 1 | P | P | P | P | P | P |
| e9-ev-399 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @676 | Y | 1 | P | P | P | P | P | P |
| e9-ev-400 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @677 | Y | 1 | P | P | P | P | P | P |
| e9-ev-401 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @678 | Y | 1 | P | P | P | P | P | P |
| e9-ev-402 | boundary | broker | S20-relay-final | `exec:pre/COMMIT` @681 | Y | 1 | P | P | P | P | P | P |
| e9-ev-403 | boundary | broker | S20-relay-final | `exec:post/COMMIT` @682 | Y | 1 | P | P | P | P | P | P |
| e9-ev-404 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @687 | Y | 1 | P | P | P | P | P | P |
| e9-ev-405 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @688 | Y | 1 | P | P | P | P | P | P |
| e9-ev-406 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @689 | Y | 1 | P | P | P | P | P | P |
| e9-ev-407 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @690 | Y | 1 | P | P | P | P | P | P |
| e9-ev-408 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @691 | Y | 1 | P | P | P | P | P | P |
| e9-ev-409 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @692 | Y | 1 | P | P | P | P | P | P |
| e9-ev-410 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @693 | Y | 1 | P | P | P | P | P | P |
| e9-ev-411 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @694 | Y | 1 | P | P | P | P | P | P |
| e9-ev-412 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @695 | Y | 1 | P | P | P | P | P | P |
| e9-ev-413 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @696 | Y | 1 | P | P | P | P | P | P |
| e9-ev-414 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @697 | Y | 1 | P | P | P | P | P | P |
| e9-ev-415 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @698 | Y | 1 | P | P | P | P | P | P |
| e9-ev-416 | boundary | broker | S20-relay-final | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @699 | Y | 1 | P | P | P | P | P | P |
| e9-ev-417 | boundary | broker | S20-relay-final | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @700 | Y | 1 | P | P | P | P | P | P |
| e9-ev-418 | boundary | broker | S20-relay-final | `exec:pre/BEGIN IMMEDIATE` @705 | Y | 1 | P | P | P | P | P | P |
| e9-ev-419 | boundary | broker | S20-relay-final | `exec:post/BEGIN IMMEDIATE` @706 | Y | 1 | P | P | P | P | P | P |
| e9-ev-420 | boundary | broker | S20-relay-final | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @711 | Y | 1 | P | P | P | P | P | P |
| e9-ev-421 | boundary | broker | S20-relay-final | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @712 | Y | 1 | P | P | P | P | P | P |
| e9-ev-422 | boundary | broker | S20-relay-final | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @715 | Y | 1 | P | P | P | P | P | P |
| e9-ev-423 | boundary | broker | S20-relay-final | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @716 | Y | 1 | P | P | P | P | P | P |
| e9-ev-424 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @717 | Y | 1 | P | P | P | P | P | P |
| e9-ev-425 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @718 | Y | 1 | P | P | P | P | P | P |
| e9-ev-426 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @719 | Y | 1 | P | P | P | P | P | P |
| e9-ev-427 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @720 | Y | 1 | P | P | P | P | P | P |
| e9-ev-428 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @721 | Y | 1 | P | P | P | P | P | P |
| e9-ev-429 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @722 | Y | 1 | P | P | P | P | P | P |
| e9-ev-430 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @723 | Y | 1 | P | P | P | P | P | P |
| e9-ev-431 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @724 | Y | 1 | P | P | P | P | P | P |
| e9-ev-432 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @725 | Y | 1 | P | P | P | P | P | P |
| e9-ev-433 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @726 | Y | 1 | P | P | P | P | P | P |
| e9-ev-434 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @727 | Y | 1 | P | P | P | P | P | P |
| e9-ev-435 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @728 | Y | 1 | P | P | P | P | P | P |
| e9-ev-436 | boundary | broker | S20-relay-final | `exec:pre/COMMIT` @731 | Y | 1 | P | P | P | P | P | P |
| e9-ev-437 | boundary | broker | S20-relay-final | `exec:post/COMMIT` @732 | Y | 1 | P | P | P | P | P | P |
| e9-ev-438 | boundary | broker | S21-reconcile-final | `exec:pre/BEGIN IMMEDIATE` @737 | Y | 1 | P | P | P | P | P | P |
| e9-ev-439 | boundary | broker | S21-reconcile-final | `exec:post/BEGIN IMMEDIATE` @738 | Y | 1 | P | P | P | P | P | P |
| e9-ev-440 | boundary | broker | S21-reconcile-final | `exec:pre/COMMIT` @741 | Y | 1 | P | P | P | P | P | P |
| e9-ev-441 | boundary | broker | S21-reconcile-final | `exec:post/COMMIT` @742 | Y | 1 | P | P | P | P | P | P |
| e9-ev-442 | boundary | broker | S21-reconcile-final | `exec:pre/BEGIN IMMEDIATE` @743 | Y | 1 | P | P | P | P | P | P |
| e9-ev-443 | boundary | broker | S21-reconcile-final | `exec:post/BEGIN IMMEDIATE` @744 | Y | 1 | P | P | P | P | P | P |
| e9-ev-444 | boundary | broker | S21-reconcile-final | `exec:pre/COMMIT` @747 | Y | 1 | P | P | P | P | P | P |
| e9-ev-445 | boundary | broker | S21-reconcile-final | `exec:post/COMMIT` @748 | Y | 1 | P | P | P | P | P | P |
| e9-ev-446 | boundary | broker | S04-reconcile-A | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @101 | Y | 1 | P | P | P | P | P | P |
| e9-ev-447 | boundary | broker | S04-reconcile-A | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @102 | Y | 1 | P | P | P | P | P | P |
| e9-ev-448 | boundary | broker | S04-reconcile-A | `get:pre/SELECT * FROM session_presence WHERE host = ? AND session_id =` @103 | Y | 1 | P | P | P | P | P | P |
| e9-ev-449 | boundary | broker | S04-reconcile-A | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @104 | Y | 1 | P | P | P | P | P | P |
| e9-ev-450 | boundary | broker | S04-reconcile-A | `exec:pre/PRAGMA query_only = ON; BEGIN;` @105 | Y | 1 | P | P | P | P | P | P |
| e9-ev-451 | boundary | broker | S04-reconcile-A | `exec:post/PRAGMA query_only = ON; BEGIN;` @106 | Y | 1 | P | P | P | P | P | P |
| e9-ev-452 | boundary | broker | S04-reconcile-A | `get:pre/SELECT value FROM trust_metadata WHERE key = ?` @107 | Y | 1 | P | P | P | P | P | P |
| e9-ev-453 | boundary | broker | S04-reconcile-A | `get:post/SELECT value FROM trust_metadata WHERE key = ?` @108 | Y | 1 | P | P | P | P | P | P |
| e9-ev-454 | boundary | broker | S04-reconcile-A | `get:pre/SELECT receipt_json FROM input_source_receipts WHERE receipt_i` @109 | Y | 1 | P | P | P | P | P | P |
| e9-ev-455 | boundary | broker | S04-reconcile-A | `get:post/SELECT receipt_json FROM input_source_receipts WHERE receipt_` @110 | Y | 1 | P | P | P | P | P | P |
| e9-ev-456 | boundary | broker | S04-reconcile-A | `get:pre/SELECT * FROM session_presence WHERE host = ? AND session_id =` @111 | Y | 1 | P | P | P | P | P | P |
| e9-ev-457 | boundary | broker | S04-reconcile-A | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @112 | Y | 1 | P | P | P | P | P | P |
| e9-ev-458 | boundary | broker | S05-reconcile-A-again | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @119 | Y | 1 | P | P | P | P | P | P |
| e9-ev-459 | boundary | broker | S05-reconcile-A-again | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @120 | Y | 1 | P | P | P | P | P | P |
| e9-ev-460 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @739 | Y | 1 | P | P | P | P | P | P |
| e9-ev-461 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @740 | Y | 1 | P | P | P | P | P | P |
| e9-ev-462 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @745 | Y | 1 | P | P | P | P | P | P |
| e9-ev-463 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @746 | Y | 1 | P | P | P | P | P | P |
| e9-ev-464 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @749 | Y | 1 | P | P | P | P | P | P |
| e9-ev-465 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @750 | Y | 1 | P | P | P | P | P | P |
| e9-ev-466 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @751 | Y | 1 | P | P | P | P | P | P |
| e9-ev-467 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @752 | Y | 1 | P | P | P | P | P | P |
| e9-ev-468 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @753 | Y | 1 | P | P | P | P | P | P |
| e9-ev-469 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @754 | Y | 1 | P | P | P | P | P | P |
| e9-ev-470 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-471 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-472 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | P | P | P |
| e9-ev-473 | boundary | relay#2 | S08-relay-A | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-474 | boundary | relay#2 | S08-relay-A | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-475 | boundary | relay#2 | S08-relay-A | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | P | P | P |
| e9-ev-476 | boundary | relay#2 | S08-relay-A | `point/relay:after-start` @4 | Y | 0 | P | P | P | P | P | P |
| e9-ev-477 | boundary | relay#2 | S08-relay-A | `point/relay:after-effect` @7 | Y | 0 | P | P | P | P | P | P |
| e9-ev-478 | boundary | relay#2 | S08-relay-A | `point/relay:after-outcome` @8 | Y | 0 | P | P | P | P | P | P |
| e9-ev-479 | boundary | hook#1 | S09-hooks | `exec:pre/PRAGMA journal_mode = WAL;` @5 | Y | 0 | P | P | P | P | P | P |
| e9-ev-480 | boundary | hook#1 | S09-hooks | `exec:post/PRAGMA journal_mode = WAL;` @6 | Y | 0 | P | P | P | P | P | P |
| e9-ev-481 | boundary | hook#1 | S09-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @9 | Y | 0 | P | P | P | P | P | P |
| e9-ev-482 | boundary | hook#1 | S09-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @10 | Y | 0 | P | P | P | P | P | P |
| e9-ev-483 | boundary | hook#1 | S09-hooks | `exec:pre/BEGIN IMMEDIATE;` @11 | Y | 0 | P | P | P | P | P | P |
| e9-ev-484 | boundary | hook#1 | S09-hooks | `exec:post/BEGIN IMMEDIATE;` @12 | Y | 0 | P | P | P | P | P | P |
| e9-ev-485 | boundary | hook#1 | S09-hooks | `exec:pre/COMMIT;` @15 | Y | 0 | P | P | P | P | P | P |
| e9-ev-486 | boundary | hook#1 | S09-hooks | `exec:post/COMMIT;` @16 | Y | 0 | P | P | P | P | P | P |
| e9-ev-487 | boundary | hook#1 | S09-hooks | `exec:pre/BEGIN IMMEDIATE;` @17 | Y | 0 | P | P | P | P | P | P |
| e9-ev-488 | boundary | hook#1 | S09-hooks | `exec:post/BEGIN IMMEDIATE;` @18 | Y | 0 | P | P | P | P | P | P |
| e9-ev-489 | boundary | hook#1 | S09-hooks | `run:pre/INSERT INTO input_source_receipts ( receipt_id, host, session_` @21 | Y | 0 | P | P | P | P | P | P |
| e9-ev-490 | boundary | hook#1 | S09-hooks | `run:post/INSERT INTO input_source_receipts ( receipt_id, host, session` @22 | Y | 0 | P | P | P | P | P | P |
| e9-ev-491 | boundary | hook#1 | S09-hooks | `exec:pre/COMMIT;` @23 | Y | 0 | P | P | P | P | P | P |
| e9-ev-492 | boundary | hook#1 | S09-hooks | `exec:post/COMMIT;` @24 | Y | 0 | P | P | P | P | P | P |
| e9-ev-493 | boundary | hook#1 | S09-hooks | `point/hook:after-receipt` @25 | Y | 0 | P | P | P | P | P | P |
| e9-ev-494 | boundary | hook#1 | S09-hooks | `point/hook:after-claim` @26 | Y | 0 | P | P | P | P | P | P |
| e9-ev-495 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-496 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-497 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | P | P | P |
| e9-ev-498 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-start` @4 | Y | 0 | P | P | P | P | P | P |
| e9-ev-499 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-effect` @7 | Y | 0 | P | P | P | P | P | P |
| e9-ev-500 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-outcome` @8 | Y | 0 | P | P | P | P | P | P |
| e9-ev-501 | boundary | hook#2 | S16-hooks | `exec:pre/PRAGMA journal_mode = WAL;` @5 | Y | 0 | P | P | P | P | P | P |
| e9-ev-502 | boundary | hook#2 | S16-hooks | `exec:post/PRAGMA journal_mode = WAL;` @6 | Y | 0 | P | P | P | P | P | P |
| e9-ev-503 | boundary | hook#2 | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @9 | Y | 0 | P | P | P | P | P | P |
| e9-ev-504 | boundary | hook#2 | S16-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @10 | Y | 0 | P | P | P | P | P | P |
| e9-ev-505 | boundary | hook#2 | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @11 | Y | 0 | P | P | P | P | P | P |
| e9-ev-506 | boundary | hook#2 | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @12 | Y | 0 | P | P | P | P | P | P |
| e9-ev-507 | boundary | hook#2 | S16-hooks | `exec:pre/COMMIT;` @15 | Y | 0 | P | P | P | P | P | P |
| e9-ev-508 | boundary | hook#2 | S16-hooks | `exec:post/COMMIT;` @16 | Y | 0 | P | P | P | P | P | P |
| e9-ev-509 | boundary | hook#2 | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @17 | Y | 0 | P | P | P | P | P | P |
| e9-ev-510 | boundary | hook#2 | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @18 | Y | 0 | P | P | P | P | P | P |
| e9-ev-511 | boundary | hook#2 | S16-hooks | `run:pre/INSERT INTO input_source_receipts ( receipt_id, host, session_` @21 | Y | 0 | P | P | P | P | P | P |
| e9-ev-512 | boundary | hook#2 | S16-hooks | `run:post/INSERT INTO input_source_receipts ( receipt_id, host, session` @22 | Y | 0 | P | P | P | P | P | P |
| e9-ev-513 | boundary | hook#2 | S16-hooks | `exec:pre/COMMIT;` @23 | Y | 0 | P | P | P | P | P | P |
| e9-ev-514 | boundary | hook#2 | S16-hooks | `exec:post/COMMIT;` @24 | Y | 0 | P | P | P | P | P | P |
| e9-ev-515 | boundary | hook#2 | S16-hooks | `point/hook:after-receipt` @25 | Y | 0 | P | P | P | P | P | P |
| e9-ev-516 | boundary | hook#2 | S16-hooks | `point/hook:after-claim` @26 | Y | 0 | P | P | P | P | P | P |
| e9-ev-517 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-518 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-519 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | P | P | P |
| e9-ev-520 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-start` @4 | Y | 0 | P | P | P | P | P | P |
| e9-ev-521 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-effect` @7 | Y | 0 | P | P | P | P | P | P |
| e9-ev-522 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-outcome` @8 | Y | 0 | P | P | P | P | P | P |
| e9-ev-523 | boundary | hook#3 | S18-hooks | `exec:pre/PRAGMA journal_mode = WAL;` @5 | Y | 0 | P | P | P | P | P | P |
| e9-ev-524 | boundary | hook#3 | S18-hooks | `exec:post/PRAGMA journal_mode = WAL;` @6 | Y | 0 | P | P | P | P | P | P |
| e9-ev-525 | boundary | hook#3 | S18-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @9 | Y | 0 | P | P | P | P | P | P |
| e9-ev-526 | boundary | hook#3 | S18-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @10 | Y | 0 | P | P | P | P | P | P |
| e9-ev-527 | boundary | hook#3 | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @11 | Y | 0 | P | P | P | P | P | P |
| e9-ev-528 | boundary | hook#3 | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @12 | Y | 0 | P | P | P | P | P | P |
| e9-ev-529 | boundary | hook#3 | S18-hooks | `exec:pre/COMMIT;` @15 | Y | 0 | P | P | P | P | P | P |
| e9-ev-530 | boundary | hook#3 | S18-hooks | `exec:post/COMMIT;` @16 | Y | 0 | P | P | P | P | P | P |
| e9-ev-531 | boundary | hook#3 | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @17 | Y | 0 | P | P | P | P | P | P |
| e9-ev-532 | boundary | hook#3 | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @18 | Y | 0 | P | P | P | P | P | P |
| e9-ev-533 | boundary | hook#3 | S18-hooks | `run:pre/INSERT INTO input_source_receipts ( receipt_id, host, session_` @21 | Y | 0 | P | P | P | P | P | P |
| e9-ev-534 | boundary | hook#3 | S18-hooks | `run:post/INSERT INTO input_source_receipts ( receipt_id, host, session` @22 | Y | 0 | P | P | P | P | P | P |
| e9-ev-535 | boundary | hook#3 | S18-hooks | `exec:pre/COMMIT;` @23 | Y | 0 | P | P | P | P | P | P |
| e9-ev-536 | boundary | hook#3 | S18-hooks | `exec:post/COMMIT;` @24 | Y | 0 | P | P | P | P | P | P |
| e9-ev-537 | boundary | hook#3 | S18-hooks | `point/hook:after-receipt` @25 | Y | 0 | P | P | P | P | P | P |
| e9-ev-538 | boundary | hook#3 | S18-hooks | `point/hook:after-claim` @26 | Y | 0 | P | P | P | P | P | P |
| e9-ev-539 | boundary | relay#5 | S20-relay-final | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-540 | boundary | relay#5 | S20-relay-final | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-541 | boundary | relay#6 | S20-relay-final | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | P | P | P |
| e9-ev-542 | boundary | relay#6 | S20-relay-final | `point/relay:after-tick` @2 | Y | 0 | P | P | P | P | P | P |
| e9-ev-543 | boundary | broker | S00-broker-start | `exec:pre/BEGIN IMMEDIATE` @7 | Y | 1 | P | P | P | P | P | P |
| e9-ev-544 | boundary | broker | S00-broker-start | `exec:post/CREATE TABLE IF NOT EXISTS prepared_messages ( message_id TE` @10 | Y | 1 | P | P | P | P | P | P |
| e9-ev-545 | boundary | broker | S00-broker-start | `exec:pre/CREATE TABLE IF NOT EXISTS input_observations ( host TEXT NOT` @15 | Y | 1 | P | P | P | P | P | P |
| e9-ev-546 | boundary | broker | S00-broker-start | `exec:post/COMMIT` @22 | Y | 1 | P | P | P | P | P | P |
| e9-tm-000 | timing(+126us) | broker | S17-relay-D2 | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @519 | Y | 1 | P | P | P | P | P | P |
| e9-tm-001 | timing(+518us) | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @142 | Y | 1 | P | P | P | P | P | P |
| e9-tm-002 | timing(+122us) | broker | S17-relay-D2 | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @580 | Y | 1 | P | P | P | P | P | P |
| e9-tm-003 | timing(+593us) | broker | S17-relay-D2 | `get:post/SELECT retry_count FROM wake_nonces WHERE nonce_digest = ? AN` @594 | Y | 1 | P | P | P | P | P | P |
| e9-tm-004 | timing(+452us) | broker | S13-send-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @313 | Y | 1 | P | P | P | P | P | P |
| e9-tm-005 | timing(+156us) | broker | S18-hooks | `get:post/PRAGMA user_version` @608 | Y | 1 | P | P | P | P | P | P |
| e9-tm-006 | timing(+225us) | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @678 | Y | 1 | P | P | P | P | P | P |
| e9-tm-007 | timing(+316us) | broker | S17-relay-D2 | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @558 | Y | 1 | P | P | P | P | P | P |
| e9-tm-008 | timing(+136us) | broker | S03-relay-A-latched | `exec:post/BEGIN IMMEDIATE` @50 | Y | 1 | P | P | P | P | P | P |
| e9-tm-009 | timing(+301us) | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @35 | Y | 1 | P | P | P | P | P | P |
| e9-tm-010 | timing(+234us) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @402 | Y | 1 | P | P | P | P | P | P |
| e9-tm-011 | timing(+103us) | broker | S08-relay-A | `get:pre/SELECT relay_id, pid, parent_pid FROM relay_leases WHERE host ` @183 | Y | 1 | P | P | P | P | P | P |
| e9-tm-012 | timing(+537us) | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @401 | Y | 1 | P | P | P | P | P | P |
| e9-tm-013 | timing(+551us) | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @188 | Y | 1 | P | P | P | P | P | P |
| e9-tm-014 | timing(+541us) | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @491 | Y | 1 | P | P | P | P | P | P |
| e9-tm-015 | timing(+207us) | broker | S20-relay-final | `get:post/SELECT count(*) AS count FROM messages WHERE target_host = ? ` @680 | Y | 1 | P | P | P | P | P | P |
| e9-tm-016 | timing(+279us) | broker | S12-prepare-D | `get:post/SELECT count(*) AS count FROM prepared_messages WHERE receipt` @302 | Y | 1 | P | P | P | P | P | P |
| e9-tm-017 | timing(+9us) | broker | S17-relay-D2 | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @572 | Y | 1 | P | P | P | P | P | P |
| e9-tm-018 | timing(+332us) | broker | S12-prepare-D | `get:pre/SELECT count(*) AS count FROM prepared_messages WHERE receipt ` @301 | Y | 1 | P | P | P | P | P | P |
| e9-tm-019 | timing(+339us) | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @672 | Y | 1 | P | P | P | P | P | P |
| e9-tm-020 | timing(+409us) | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @334 | Y | 1 | P | P | P | P | P | P |
| e9-tm-021 | timing(+322us) | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @291 | Y | 1 | P | P | P | P | P | P |
| e9-tm-022 | timing(+419us) | broker | S04-reconcile-A | `exec:post/PRAGMA query_only = ON; BEGIN;` @106 | Y | 1 | P | P | P | P | P | P |
| e9-tm-023 | timing(+535us) | broker | S04-reconcile-A | `exec:pre/COMMIT` @115 | Y | 1 | P | P | P | P | P | P |
| e9-tm-024 | timing(+249us) | broker | S13-send-D | `get:post/SELECT count(*) AS count FROM prepared_messages WHERE receipt` @326 | Y | 1 | P | P | P | P | P | P |
| e9-tm-025 | timing(+164us) | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @609 | Y | 1 | P | P | P | P | P | P |
| e9-tm-026 | timing(+517us) | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @334 | Y | 1 | P | P | P | P | P | P |
| e9-tm-027 | timing(+242us) | broker | S17-relay-D2 | `get:pre/SELECT 1 FROM messages WHERE target_host = ? AND target_sessio` @585 | Y | 1 | P | P | P | P | P | P |
| e9-tm-028 | timing(+30us) | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @689 | Y | 1 | P | P | P | P | P | P |
| e9-tm-029 | timing(+22us) | broker | S11-presence-D1 | `get:pre/SELECT * FROM session_presence WHERE host = ? AND session_id =` @283 | Y | 1 | P | P | P | P | P | P |
