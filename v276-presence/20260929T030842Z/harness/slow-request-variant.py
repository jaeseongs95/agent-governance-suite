#!/usr/bin/env python3
"""Temporary variant (never committed): the large-DB and B1 brokers get the slow list-presence preload."""
import pathlib, sys
p = pathlib.Path("tests/session-messaging/presence-retention.test.ts")
s = p.read_text(encoding="utf-8")
old = 'const child = spawn(process.execPath, ["--import", "tsx", sourceBroker, "--state-directory", state], { windowsHide: true, stdio: "ignore" });'
new = ('const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(fileURLToPath(new URL("./fixtures/slow-list-presence.mjs", import.meta.url))).href, sourceBroker, "--state-directory", state],'
       ' { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_TEST_LIST_PRESENCE_DELAY_MS: process.env.SLOW_MS } });')
assert s.count(old) == 2, s.count(old)
p.write_text(s.replace(old, new), encoding="utf-8")
