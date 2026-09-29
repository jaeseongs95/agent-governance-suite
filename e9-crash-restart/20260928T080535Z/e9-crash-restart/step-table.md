## e9
| step | 프로세스 | kill 지점 | 그중 BEGIN/COMMIT 직전·직후 | 위반 |
|---|---|---|---|---|
| S00 broker-start | broker | 4 | 2 | 0 |
| S01 presence-A3 | broker | 2 | 0 | 0 |
| S02 presence-B3 | broker | 2 | 0 | 0 |
| S03 relay-A-latched | broker | 52 | 9 | 0 |
| S03 relay-A-latched | relay | 3 | 0 | 0 |
| S04 reconcile-A | broker | 27 | 13 | 0 |
| S05 reconcile-A-again | broker | 6 | 4 | 0 |
| S06 reconcile-B-foreign | broker | 4 | 4 | 0 |
| S07 reconcile-B-bogus | broker | 4 | 4 | 0 |
| S08 relay-A | broker | 70 | 19 | 0 |
| S08 relay-A | relay | 6 | 0 | 0 |
| S09 hooks | broker | 23 | 19 | 1 |
| S09 hooks | hook | 16 | 10 | 0 |
| S10 ack-A | broker | 6 | 4 | 0 |
| S11 presence-D1 | broker | 3 | 0 | 0 |
| S12 prepare-D | broker | 21 | 4 | 0 |
| S13 send-D | broker | 36 | 4 | 0 |
| S14 relay-D1 | broker | 74 | 25 | 0 |
| S14 relay-D1 | relay | 6 | 0 | 0 |
| S15 presence-D2 | broker | 2 | 0 | 0 |
| S16 hooks | broker | 16 | 14 | 1 |
| S16 hooks | hook | 16 | 10 | 0 |
| S17 relay-D2 | broker | 74 | 19 | 0 |
| S17 relay-D2 | relay | 6 | 0 | 0 |
| S18 hooks | broker | 19 | 13 | 1 |
| S18 hooks | hook | 16 | 10 | 0 |
| S19 ack-D | broker | 6 | 4 | 0 |
| S20 relay-final | broker | 72 | 8 | 0 |
| S20 relay-final | relay | 4 | 0 | 0 |
| S21 reconcile-final | broker | 18 | 8 | 0 |
## 53
| step | 프로세스 | kill 지점 | 그중 BEGIN/COMMIT 직전·직후 | 위반 |
|---|---|---|---|---|
| S00 broker-start | broker | 10 | 3 | 0 |
| S01 presence-A3 | broker | 2 | 0 | 0 |
| S02 presence-B3 | broker | 2 | 0 | 0 |
| S03 relay-A-latched | broker | 56 | 9 | 0 |
| S03 relay-A-latched | relay | 3 | 0 | 0 |
| S08 relay-A | broker | 56 | 10 | 0 |
| S08 relay-A | relay | 3 | 0 | 0 |
| S11 presence-D1 | broker | 2 | 0 | 0 |
| S12 prepare-D | broker | 19 | 4 | 0 |
| S13 send-D | broker | 35 | 4 | 0 |
| S14 relay-D1 | broker | 75 | 24 | 0 |
| S14 relay-D1 | relay | 6 | 0 | 0 |
| S15 presence-D2 | broker | 2 | 0 | 0 |
| S16 hooks | broker | 25 | 20 | 1 |
| S16 hooks | hook | 16 | 10 | 0 |
| S17 relay-D2 | broker | 73 | 21 | 0 |
| S17 relay-D2 | relay | 6 | 0 | 0 |
| S18 hooks | broker | 20 | 12 | 1 |
| S18 hooks | hook | 16 | 10 | 0 |
| S19 ack-D | broker | 7 | 4 | 0 |
| S20 relay-final | broker | 91 | 12 | 0 |
| S20 relay-final | relay | 5 | 0 | 0 |
| S21 reconcile-final | broker | 7 | 0 | 0 |
