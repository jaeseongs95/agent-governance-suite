import fs from "node:fs";
import path from "node:path";
import {syncBuiltinESMExports} from "node:module";

// 시험 소유 디렉터리의 두 번째 실제 open 완료만 보류한다. 원 I/O 결과는 바꾸지 않는다.
const directory = process.env.AGS_ROTATION_OPEN_GATE;
const open = fs.open;
let openings = 0;
if (directory) {
  fs.open = function (...args) {
    const file = String(args[0]);
    const callback = args.at(-1);
    if (file.startsWith(path.join(directory, "safe-fixture.")) && file.endsWith(".log")
      && typeof callback === "function" && ++openings === 2) {
      args[args.length - 1] = (...result) => {
        process.send?.({fixture: "rotation-open-held", file: path.basename(file), error: result[0]?.code ?? null});
        const timer = setInterval(() => {
          if (!fs.existsSync(path.join(directory, "release-open"))) return;
          clearInterval(timer);
          callback(...result);
          process.send?.({fixture: "rotation-open-released"});
        }, 5);
        timer.unref();
      };
    }
    return open.apply(this, args);
  };
  syncBuiltinESMExports();
}
