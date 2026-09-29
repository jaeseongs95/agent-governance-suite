# Kill points 53

| id | mode | role | step | kill label (trace) | killed | restarts | a | b | c | d | e | f |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v53-dk-000 | double(2nd@59) | broker | S17-relay-D2 | `exec:pre/COMMIT` @475 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-001 | double(2nd@39) | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @477 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-002 | double(2nd@41) | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @149 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-003 | double(2nd@39) | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @481 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-004 | double(2nd@49) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @256 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-005 | double(2nd@30) | broker | S14-relay-D1 | `exec:post/COMMIT` @282 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-006 | double(2nd@27) | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @118 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-007 | double(2nd@5) | broker | S18-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @514 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-008 | double(2nd@45) | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @478 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-009 | double(2nd@35) | broker | S16-hooks | `exec:post/COMMIT;` @366 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-010 | double(2nd@27) | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @359 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-011 | double(2nd@38) | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE` @349 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-012 | double(2nd@3) | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE` @349 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-013 | double(2nd@47) | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @428 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-014 | double(2nd@3) | broker | S18-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @514 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-015 | double(2nd@53) | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @359 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-016 | double(2nd@45) | broker | S14-relay-D1 | `exec:pre/COMMIT` @281 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-017 | double(2nd@41) | broker | S16-hooks | `exec:pre/COMMIT;` @365 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-018 | double(2nd@7) | broker | S14-relay-D1 | `exec:pre/COMMIT` @319 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-019 | double(2nd@27) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @338 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-020 | double(2nd@57) | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @337 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-021 | double(2nd@18) | broker | S16-hooks | `run:pre/UPDATE wake_nonces SET late_observed_at = coalesce(late_observ` @373 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-022 | double(2nd@8) | broker | S18-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @514 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-023 | double(2nd@22) | broker | S17-relay-D2 | `exec:post/COMMIT` @422 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-024 | double(2nd@52) | broker | S16-hooks | `run:post/UPDATE wake_nonces SET late_observed_at = coalesce(late_obser` @374 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-025 | double(2nd@45) | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @473 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-026 | double(2nd@37) | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @498 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-027 | double(2nd@2) | broker | S16-hooks | `exec:post/COMMIT;` @366 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-028 | double(2nd@57) | broker | S18-hooks | `run:pre/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_` @511 | Y | 2 | P | P | P | NA | P | P |
| v53-dk-029 | double(2nd@46) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @256 | Y | 2 | P | P | P | NA | P | P |
| v53-down-0 | outage-35s(down 35000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @350 | Y | 1 | P | **F** | P | NA | P | P |
| v53-down-1 | outage-35s(down 35000ms) | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE` @486 | Y | 1 | P | **F** | P | NA | P | P |
| v53-downctl-10s | outage-10s(down 10000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @350 | Y | 1 | P | P | P | NA | P | P |
| v53-downctl-25s | outage-25s(down 25000ms) | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @350 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-000 | boundary | broker | S01-presence-A3 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @23 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-001 | boundary | broker | S01-presence-A3 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @24 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-002 | boundary | broker | S02-presence-B3 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @27 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-003 | boundary | broker | S02-presence-B3 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @28 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-004 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @31 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-005 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @32 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-006 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @33 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-007 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @34 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-008 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @35 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-009 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @36 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-010 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @37 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-011 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @38 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-012 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @39 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-013 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @40 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-014 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @41 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-015 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @42 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-016 | boundary | broker | S03-relay-A-latched | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @43 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-017 | boundary | broker | S03-relay-A-latched | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @44 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-018 | boundary | broker | S03-relay-A-latched | `exec:pre/BEGIN IMMEDIATE` @49 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-019 | boundary | broker | S03-relay-A-latched | `exec:post/BEGIN IMMEDIATE` @50 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-020 | boundary | broker | S03-relay-A-latched | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @55 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-021 | boundary | broker | S03-relay-A-latched | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @56 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-022 | boundary | broker | S03-relay-A-latched | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @59 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-023 | boundary | broker | S03-relay-A-latched | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @60 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-024 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @61 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-025 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @62 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-026 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @63 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-027 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @64 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-028 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @65 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-029 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @66 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-030 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @67 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-031 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @68 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-032 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @69 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-033 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @70 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-034 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @71 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-035 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @72 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-036 | boundary | broker | S03-relay-A-latched | `exec:pre/COMMIT` @75 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-037 | boundary | broker | S03-relay-A-latched | `exec:post/COMMIT` @76 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-038 | boundary | broker | S03-relay-A-latched | `exec:pre/BEGIN IMMEDIATE` @81 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-039 | boundary | broker | S03-relay-A-latched | `exec:post/BEGIN IMMEDIATE` @82 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-040 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @83 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-041 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @84 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-042 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @85 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-043 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @86 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-044 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @87 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-045 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @88 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-046 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @89 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-047 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @90 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-048 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @91 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-049 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @92 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-050 | boundary | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @93 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-051 | boundary | broker | S03-relay-A-latched | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @94 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-052 | boundary | broker | S03-relay-A-latched | `exec:pre/COMMIT` @97 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-053 | boundary | broker | S03-relay-A-latched | `exec:post/COMMIT` @98 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-054 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @99 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-055 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @100 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-056 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @101 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-057 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @102 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-058 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @103 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-059 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @104 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-060 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @105 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-061 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @106 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-062 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @107 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-063 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @108 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-064 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @109 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-065 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @110 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-066 | boundary | broker | S08-relay-A | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @111 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-067 | boundary | broker | S08-relay-A | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @112 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-068 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @117 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-069 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @118 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-070 | boundary | broker | S08-relay-A | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @123 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-071 | boundary | broker | S08-relay-A | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @124 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-072 | boundary | broker | S08-relay-A | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @127 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-073 | boundary | broker | S08-relay-A | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @128 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-074 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @129 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-075 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @130 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-076 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @131 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-077 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @132 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-078 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @133 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-079 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @134 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-080 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @135 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-081 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @136 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-082 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @137 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-083 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @138 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-084 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @139 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-085 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @140 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-086 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @143 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-087 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @144 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-088 | boundary | broker | S08-relay-A | `exec:pre/BEGIN IMMEDIATE` @149 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-089 | boundary | broker | S08-relay-A | `exec:post/BEGIN IMMEDIATE` @150 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-090 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @151 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-091 | boundary | broker | S08-relay-A | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @152 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-092 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @153 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-093 | boundary | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @154 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-094 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @155 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-095 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @156 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-096 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @157 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-097 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @158 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-098 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @159 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-099 | boundary | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @160 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-100 | boundary | broker | S08-relay-A | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @161 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-101 | boundary | broker | S08-relay-A | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @162 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-102 | boundary | broker | S08-relay-A | `exec:pre/COMMIT` @165 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-103 | boundary | broker | S08-relay-A | `exec:post/COMMIT` @166 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-104 | boundary | broker | S11-presence-D1 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @167 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-105 | boundary | broker | S11-presence-D1 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @168 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-106 | boundary | broker | S12-prepare-D | `exec:pre/BEGIN IMMEDIATE` @171 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-107 | boundary | broker | S12-prepare-D | `exec:post/BEGIN IMMEDIATE` @172 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-108 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @173 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-109 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @174 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-110 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @175 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-111 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @176 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-112 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @177 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-113 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @178 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-114 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @179 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-115 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @180 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-116 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @181 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-117 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @182 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-118 | boundary | broker | S12-prepare-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @183 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-119 | boundary | broker | S12-prepare-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @184 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-120 | boundary | broker | S12-prepare-D | `run:pre/INSERT INTO prepared_messages (message_id, sender_host, sender` @191 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-121 | boundary | broker | S12-prepare-D | `run:post/INSERT INTO prepared_messages (message_id, sender_host, sende` @192 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-122 | boundary | broker | S12-prepare-D | `exec:pre/COMMIT` @193 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-123 | boundary | broker | S12-prepare-D | `exec:post/COMMIT` @194 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-124 | boundary | broker | S13-send-D | `exec:pre/BEGIN IMMEDIATE` @195 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-125 | boundary | broker | S13-send-D | `exec:post/BEGIN IMMEDIATE` @196 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-126 | boundary | broker | S13-send-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @197 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-127 | boundary | broker | S13-send-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @198 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-128 | boundary | broker | S13-send-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @199 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-129 | boundary | broker | S13-send-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @200 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-130 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @201 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-131 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @202 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-132 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @203 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-133 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @204 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-134 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @205 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-135 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @206 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-136 | boundary | broker | S13-send-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @207 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-137 | boundary | broker | S13-send-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @208 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-138 | boundary | broker | S13-send-D | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @213 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-139 | boundary | broker | S13-send-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @214 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-140 | boundary | broker | S13-send-D | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @215 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-141 | boundary | broker | S13-send-D | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @216 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-142 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @217 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-143 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @218 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-144 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @219 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-145 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @220 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-146 | boundary | broker | S13-send-D | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @221 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-147 | boundary | broker | S13-send-D | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @222 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-148 | boundary | broker | S13-send-D | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @223 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-149 | boundary | broker | S13-send-D | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @224 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-150 | boundary | broker | S13-send-D | `run:pre/INSERT INTO messages ( message_id, sender_host, sender_session` @229 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-151 | boundary | broker | S13-send-D | `run:post/INSERT INTO messages ( message_id, sender_host, sender_sessio` @230 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-152 | boundary | broker | S13-send-D | `run:pre/UPDATE prepared_messages SET body = NULL, receipt = ?, expires` @233 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-153 | boundary | broker | S13-send-D | `run:post/UPDATE prepared_messages SET body = NULL, receipt = ?, expire` @234 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-154 | boundary | broker | S13-send-D | `exec:pre/COMMIT` @235 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-155 | boundary | broker | S13-send-D | `exec:post/COMMIT` @236 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-156 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @237 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-157 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @238 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-158 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @239 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-159 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @240 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-160 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @241 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-161 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @242 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-162 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @243 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-163 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @244 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-164 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @245 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-165 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @246 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-166 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @247 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-167 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @248 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-168 | boundary | broker | S14-relay-D1 | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @249 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-169 | boundary | broker | S14-relay-D1 | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @250 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-170 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @255 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-171 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @256 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-172 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @261 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-173 | boundary | broker | S14-relay-D1 | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @262 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-174 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @265 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-175 | boundary | broker | S14-relay-D1 | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @266 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-176 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @267 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-177 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @268 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-178 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @269 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-179 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @270 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-180 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @271 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-181 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @272 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-182 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @273 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-183 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @274 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-184 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @275 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-185 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @276 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-186 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @277 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-187 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @278 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-188 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @281 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-189 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @282 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-190 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @287 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-191 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @288 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-192 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @289 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-193 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @290 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-194 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @291 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-195 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @292 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-196 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @293 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-197 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @294 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-198 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @295 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-199 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @296 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-200 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @297 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-201 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @298 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-202 | boundary | broker | S14-relay-D1 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @299 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-203 | boundary | broker | S14-relay-D1 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @300 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-204 | boundary | broker | S14-relay-D1 | `run:pre/INSERT INTO wake_nonces (nonce_digest, host, session_id, expir` @317 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-205 | boundary | broker | S14-relay-D1 | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @318 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-206 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @319 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-207 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @320 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-208 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @321 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-209 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @322 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-210 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @333 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-211 | boundary | broker | S14-relay-D1 | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @334 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-212 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @335 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-213 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @336 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-214 | boundary | broker | S14-relay-D1 | `exec:pre/BEGIN IMMEDIATE` @337 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-215 | boundary | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @338 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-216 | boundary | broker | S14-relay-D1 | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @341 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-217 | boundary | broker | S14-relay-D1 | `run:post/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_b` @342 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-218 | boundary | broker | S14-relay-D1 | `exec:pre/COMMIT` @343 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-219 | boundary | broker | S14-relay-D1 | `exec:post/COMMIT` @344 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-220 | boundary | broker | S15-presence-D2 | `run:pre/INSERT INTO session_presence ( host, session_id, instance_id, ` @345 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-221 | boundary | broker | S15-presence-D2 | `run:post/INSERT INTO session_presence ( host, session_id, instance_id,` @346 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-222 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE` @349 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-223 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE` @350 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-224 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @359 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-225 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @360 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-226 | boundary | broker | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @361 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-227 | boundary | broker | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @362 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-228 | boundary | broker | S16-hooks | `exec:pre/COMMIT;` @365 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-229 | boundary | broker | S16-hooks | `exec:post/COMMIT;` @366 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-230 | boundary | broker | S16-hooks | `run:pre/UPDATE wake_nonces SET late_observed_at = coalesce(late_observ` @373 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-231 | boundary | broker | S16-hooks | `run:post/UPDATE wake_nonces SET late_observed_at = coalesce(late_obser` @374 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-232 | boundary | broker | S16-hooks | `exec:pre/COMMIT` @375 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-233 | boundary | broker | S16-hooks | `exec:post/COMMIT` @376 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-234 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @377 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-235 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @378 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-236 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @379 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-237 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @380 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-238 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @381 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-239 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @382 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-240 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @383 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-241 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @384 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-242 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @385 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-243 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @386 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-244 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @387 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-245 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @388 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-246 | boundary | broker | S17-relay-D2 | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @389 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-247 | boundary | broker | S17-relay-D2 | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @390 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-248 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @395 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-249 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @396 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-250 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @401 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-251 | boundary | broker | S17-relay-D2 | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @402 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-252 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @405 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-253 | boundary | broker | S17-relay-D2 | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @406 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-254 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @407 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-255 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @408 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-256 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @409 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-257 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @410 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-258 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @411 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-259 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @412 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-260 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @413 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-261 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @414 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-262 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @415 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-263 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @416 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-264 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @417 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-265 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @418 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-266 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @421 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-267 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @422 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-268 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @427 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-269 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @428 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-270 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @429 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-271 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @430 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-272 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @431 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-273 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @432 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-274 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @433 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-275 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @434 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-276 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @435 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-277 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @436 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-278 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @437 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-279 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @438 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-280 | boundary | broker | S17-relay-D2 | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @439 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-281 | boundary | broker | S17-relay-D2 | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @440 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-282 | boundary | broker | S17-relay-D2 | `run:pre/INSERT INTO wake_nonces (nonce_digest, host, session_id, expir` @457 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-283 | boundary | broker | S17-relay-D2 | `run:post/INSERT INTO wake_nonces (nonce_digest, host, session_id, expi` @458 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-284 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @459 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-285 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @460 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-286 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @461 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-287 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @462 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-288 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = 'started', started_at = ?, disp` @473 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-289 | boundary | broker | S17-relay-D2 | `run:post/UPDATE wake_nonces SET state = 'started', started_at = ?, dis` @474 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-290 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @475 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-291 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @476 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-292 | boundary | broker | S17-relay-D2 | `exec:pre/BEGIN IMMEDIATE` @477 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-293 | boundary | broker | S17-relay-D2 | `exec:post/BEGIN IMMEDIATE` @478 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-294 | boundary | broker | S17-relay-D2 | `run:pre/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_be` @481 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-295 | boundary | broker | S17-relay-D2 | `run:post/UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_b` @482 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-296 | boundary | broker | S17-relay-D2 | `exec:pre/COMMIT` @483 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-297 | boundary | broker | S17-relay-D2 | `exec:post/COMMIT` @484 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-298 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE` @485 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-299 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE` @486 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-300 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @495 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-301 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @496 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-302 | boundary | broker | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @497 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-303 | boundary | broker | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @498 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-304 | boundary | broker | S18-hooks | `exec:pre/COMMIT;` @501 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-305 | boundary | broker | S18-hooks | `exec:post/COMMIT;` @502 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-306 | boundary | broker | S18-hooks | `run:pre/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_` @511 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-307 | boundary | broker | S18-hooks | `run:post/UPDATE messages SET claimed_at = ?, claim_until = ?, delivery` @512 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-308 | boundary | broker | S18-hooks | `run:pre/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, ob` @513 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-309 | boundary | broker | S18-hooks | `run:post/UPDATE wake_nonces SET state = 'observed', consumed_at = ?, o` @514 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-310 | boundary | broker | S18-hooks | `exec:pre/COMMIT` @515 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-311 | boundary | broker | S18-hooks | `exec:post/COMMIT` @516 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-312 | boundary | broker | S19-ack-D | `exec:pre/BEGIN IMMEDIATE` @517 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-313 | boundary | broker | S19-ack-D | `exec:post/BEGIN IMMEDIATE` @518 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-314 | boundary | broker | S19-ack-D | `run:pre/UPDATE messages SET acknowledged_at = ?, claim_until = NULL WH` @519 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-315 | boundary | broker | S19-ack-D | `run:post/UPDATE messages SET acknowledged_at = ?, claim_until = NULL W` @520 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-316 | boundary | broker | S19-ack-D | `exec:pre/COMMIT` @521 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-317 | boundary | broker | S19-ack-D | `exec:post/COMMIT` @522 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-318 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @523 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-319 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @524 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-320 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @525 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-321 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @526 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-322 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @527 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-323 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @528 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-324 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @529 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-325 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @530 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-326 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @531 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-327 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @532 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-328 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @533 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-329 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @534 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-330 | boundary | broker | S20-relay-final | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @535 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-331 | boundary | broker | S20-relay-final | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @536 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-332 | boundary | broker | S20-relay-final | `exec:pre/BEGIN IMMEDIATE` @541 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-333 | boundary | broker | S20-relay-final | `exec:post/BEGIN IMMEDIATE` @542 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-334 | boundary | broker | S20-relay-final | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @547 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-335 | boundary | broker | S20-relay-final | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @548 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-336 | boundary | broker | S20-relay-final | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @551 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-337 | boundary | broker | S20-relay-final | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @552 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-338 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @553 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-339 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @554 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-340 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @555 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-341 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @556 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-342 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @557 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-343 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @558 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-344 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @559 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-345 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @560 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-346 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @561 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-347 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @562 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-348 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @563 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-349 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @564 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-350 | boundary | broker | S20-relay-final | `exec:pre/COMMIT` @567 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-351 | boundary | broker | S20-relay-final | `exec:post/COMMIT` @568 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-352 | boundary | broker | S20-relay-final | `exec:pre/BEGIN IMMEDIATE` @573 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-353 | boundary | broker | S20-relay-final | `exec:post/BEGIN IMMEDIATE` @574 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-354 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @575 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-355 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @576 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-356 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @577 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-357 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @578 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-358 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @579 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-359 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @580 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-360 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @581 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-361 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @582 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-362 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @583 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-363 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @584 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-364 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @585 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-365 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @586 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-366 | boundary | broker | S20-relay-final | `exec:pre/COMMIT` @589 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-367 | boundary | broker | S20-relay-final | `exec:post/COMMIT` @590 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-368 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @591 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-369 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @592 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-370 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @593 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-371 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @594 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-372 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @595 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-373 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @596 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-374 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @597 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-375 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @598 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-376 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @599 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-377 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @600 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-378 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @601 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-379 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @602 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-380 | boundary | broker | S20-relay-final | `run:pre/INSERT INTO relay_leases (host, session_id, transport, relay_i` @603 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-381 | boundary | broker | S20-relay-final | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @604 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-382 | boundary | broker | S20-relay-final | `exec:pre/BEGIN IMMEDIATE` @609 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-383 | boundary | broker | S20-relay-final | `exec:post/BEGIN IMMEDIATE` @610 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-384 | boundary | broker | S20-relay-final | `run:pre/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE ` @615 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-385 | boundary | broker | S20-relay-final | `run:post/UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE` @616 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-386 | boundary | broker | S20-relay-final | `run:pre/UPDATE session_presence SET heartbeat_at = ?, lease_until = ? ` @619 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-387 | boundary | broker | S20-relay-final | `run:post/UPDATE session_presence SET heartbeat_at = ?, lease_until = ?` @620 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-388 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at` @621 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-389 | boundary | broker | S20-relay-final | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @622 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-390 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @623 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-391 | boundary | broker | S20-relay-final | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @624 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-392 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @625 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-393 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @626 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-394 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submi` @627 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-395 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @628 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-396 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @629 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-397 | boundary | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_d` @630 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-398 | boundary | broker | S20-relay-final | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @631 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-399 | boundary | broker | S20-relay-final | `run:post/DELETE FROM prepared_messages WHERE expires_at <= ?` @632 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-400 | boundary | broker | S20-relay-final | `exec:pre/COMMIT` @635 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-401 | boundary | broker | S20-relay-final | `exec:post/COMMIT` @636 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-402 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @641 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-403 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @642 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-404 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @643 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-405 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @644 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-406 | boundary | broker | S21-reconcile-final | `get:pre/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AN` @645 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-407 | boundary | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @646 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-408 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-409 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-410 | boundary | relay#1 | S03-relay-A-latched | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-411 | boundary | relay#2 | S08-relay-A | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-412 | boundary | relay#2 | S08-relay-A | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-413 | boundary | relay#2 | S08-relay-A | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-414 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-415 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-416 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-417 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-start` @4 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-418 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-effect` @7 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-419 | boundary | relay#3 | S14-relay-D1 | `point/relay:after-outcome` @8 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-420 | boundary | hook#1 | S16-hooks | `exec:pre/PRAGMA journal_mode = WAL;` @5 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-421 | boundary | hook#1 | S16-hooks | `exec:post/PRAGMA journal_mode = WAL;` @6 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-422 | boundary | hook#1 | S16-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @9 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-423 | boundary | hook#1 | S16-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @10 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-424 | boundary | hook#1 | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @11 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-425 | boundary | hook#1 | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @12 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-426 | boundary | hook#1 | S16-hooks | `exec:pre/COMMIT;` @15 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-427 | boundary | hook#1 | S16-hooks | `exec:post/COMMIT;` @16 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-428 | boundary | hook#1 | S16-hooks | `exec:pre/BEGIN IMMEDIATE;` @17 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-429 | boundary | hook#1 | S16-hooks | `exec:post/BEGIN IMMEDIATE;` @18 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-430 | boundary | hook#1 | S16-hooks | `run:pre/INSERT INTO input_source_receipts ( receipt_id, host, session_` @21 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-431 | boundary | hook#1 | S16-hooks | `run:post/INSERT INTO input_source_receipts ( receipt_id, host, session` @22 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-432 | boundary | hook#1 | S16-hooks | `exec:pre/COMMIT;` @23 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-433 | boundary | hook#1 | S16-hooks | `exec:post/COMMIT;` @24 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-434 | boundary | hook#1 | S16-hooks | `point/hook:after-receipt` @25 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-435 | boundary | hook#1 | S16-hooks | `point/hook:after-claim` @26 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-436 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-437 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-438 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-439 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-start` @4 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-440 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-effect` @7 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-441 | boundary | relay#4 | S17-relay-D2 | `point/relay:after-outcome` @8 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-442 | boundary | hook#2 | S18-hooks | `exec:pre/PRAGMA journal_mode = WAL;` @5 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-443 | boundary | hook#2 | S18-hooks | `exec:post/PRAGMA journal_mode = WAL;` @6 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-444 | boundary | hook#2 | S18-hooks | `exec:pre/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata ( ` @9 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-445 | boundary | hook#2 | S18-hooks | `exec:post/BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS trust_metadata (` @10 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-446 | boundary | hook#2 | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @11 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-447 | boundary | hook#2 | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @12 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-448 | boundary | hook#2 | S18-hooks | `exec:pre/COMMIT;` @15 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-449 | boundary | hook#2 | S18-hooks | `exec:post/COMMIT;` @16 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-450 | boundary | hook#2 | S18-hooks | `exec:pre/BEGIN IMMEDIATE;` @17 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-451 | boundary | hook#2 | S18-hooks | `exec:post/BEGIN IMMEDIATE;` @18 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-452 | boundary | hook#2 | S18-hooks | `run:pre/INSERT INTO input_source_receipts ( receipt_id, host, session_` @21 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-453 | boundary | hook#2 | S18-hooks | `run:post/INSERT INTO input_source_receipts ( receipt_id, host, session` @22 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-454 | boundary | hook#2 | S18-hooks | `exec:pre/COMMIT;` @23 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-455 | boundary | hook#2 | S18-hooks | `exec:post/COMMIT;` @24 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-456 | boundary | hook#2 | S18-hooks | `point/hook:after-receipt` @25 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-457 | boundary | hook#2 | S18-hooks | `point/hook:after-claim` @26 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-458 | boundary | relay#5 | S20-relay-final | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-459 | boundary | relay#5 | S20-relay-final | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-460 | boundary | relay#5 | S20-relay-final | `point/relay:after-reserve` @3 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-461 | boundary | relay#6 | S20-relay-final | `point/relay:after-acquire` @1 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-462 | boundary | relay#6 | S20-relay-final | `point/relay:after-tick` @2 | Y | 0 | P | P | P | NA | P | P |
| v53-ev-463 | boundary | broker | S00-broker-start | `exec:post/PRAGMA journal_mode = WAL;` @4 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-464 | boundary | broker | S00-broker-start | `exec:pre/CREATE TABLE IF NOT EXISTS messages ( message_id TEXT PRIMARY` @5 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-465 | boundary | broker | S00-broker-start | `exec:post/CREATE TABLE IF NOT EXISTS messages ( message_id TEXT PRIMAR` @6 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-466 | boundary | broker | S00-broker-start | `exec:pre/BEGIN IMMEDIATE` @7 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-467 | boundary | broker | S00-broker-start | `exec:pre/CREATE TABLE IF NOT EXISTS prepared_messages ( message_id TEX` @9 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-468 | boundary | broker | S00-broker-start | `exec:pre/CREATE TABLE IF NOT EXISTS input_observations ( host TEXT NOT` @15 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-469 | boundary | broker | S00-broker-start | `exec:pre/CREATE UNIQUE INDEX IF NOT EXISTS wake_active_target ON wake_` @19 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-470 | boundary | broker | S00-broker-start | `exec:post/CREATE UNIQUE INDEX IF NOT EXISTS wake_active_target ON wake` @20 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-471 | boundary | broker | S00-broker-start | `exec:pre/COMMIT` @21 | Y | 1 | P | P | P | NA | P | P |
| v53-ev-472 | boundary | broker | S00-broker-start | `exec:post/COMMIT` @22 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-000 | timing(+381us) | broker | S14-relay-D1 | `get:post/SELECT 1 FROM messages WHERE target_host = ? AND target_sessi` @310 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-001 | timing(+144us) | broker | S14-relay-D1 | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @326 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-002 | timing(+485us) | broker | S21-reconcile-final | `get:post/SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? A` @644 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-003 | timing(+134us) | broker | S17-relay-D2 | `run:post/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at` @434 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-004 | timing(+87us) | broker | S03-relay-A-latched | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @64 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-005 | timing(+298us) | broker | S08-relay-A | `get:post/SELECT relay_id, pid, parent_pid FROM relay_leases WHERE host` @116 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-006 | timing(+157us) | broker | S20-relay-final | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @598 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-007 | timing(+435us) | broker | S16-hooks | `get:post/SELECT receipt_json FROM input_source_receipts WHERE receipt_` @368 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-008 | timing(+427us) | broker | S03-relay-A-latched | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @44 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-009 | timing(+410us) | broker | S08-relay-A | `get:pre/SELECT * FROM session_presence WHERE host = ? AND session_id =` @119 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-010 | timing(+548us) | broker | S03-relay-A-latched | `exec:pre/COMMIT` @75 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-011 | timing(+135us) | broker | S14-relay-D1 | `get:pre/SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? ` @323 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-012 | timing(+12us) | broker | S03-relay-A-latched | `run:pre/DELETE FROM prepared_messages WHERE expires_at <= ?` @93 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-013 | timing(+167us) | broker | S13-send-D | `get:pre/SELECT count(*) AS count FROM prepared_messages WHERE receipt ` @211 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-014 | timing(+377us) | broker | S03-relay-A-latched | `get:post/SELECT * FROM session_presence WHERE host = ? AND session_id ` @52 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-015 | timing(+46us) | broker | S20-relay-final | `run:pre/DELETE FROM relay_leases WHERE lease_until <= ?` @555 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-016 | timing(+9us) | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @531 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-017 | timing(+307us) | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_di` @583 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-018 | timing(+564us) | broker | S20-relay-final | `run:pre/DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at ` @625 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-019 | timing(+14us) | broker | S17-relay-D2 | `get:pre/SELECT 1 FROM wake_nonces WHERE host = ? AND session_id = ? AN` @451 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-020 | timing(+193us) | broker | S13-send-D | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @198 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-021 | timing(+293us) | broker | S20-relay-final | `get:pre/SELECT relay_id, pid, parent_pid FROM relay_leases WHERE host ` @545 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-022 | timing(+146us) | broker | S08-relay-A | `run:post/DELETE FROM wake_nonces WHERE state IN ('observed', 'not-subm` @158 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-023 | timing(+291us) | broker | S14-relay-D1 | `exec:post/BEGIN IMMEDIATE` @338 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-024 | timing(+387us) | broker | S03-relay-A-latched | `run:post/DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_a` @62 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-025 | timing(+189us) | broker | S08-relay-A | `run:post/DELETE FROM relay_leases WHERE lease_until <= ?` @154 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-026 | timing(+109us) | broker | S19-ack-D | `run:post/UPDATE messages SET acknowledged_at = ?, claim_until = NULL W` @520 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-027 | timing(+119us) | broker | S13-send-D | `get:post/SELECT * FROM prepared_messages WHERE message_id = ? AND send` @210 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-028 | timing(+67us) | broker | S20-relay-final | `run:post/INSERT INTO relay_leases (host, session_id, transport, relay_` @604 | Y | 1 | P | P | P | NA | P | P |
| v53-tm-029 | timing(+323us) | broker | S12-prepare-D | `run:post/INSERT INTO prepared_messages (message_id, sender_host, sende` @192 | Y | 1 | P | P | P | NA | P | P |
