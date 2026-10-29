import fs from "node:fs";
import path from "node:path";
import {syncBuiltinESMExports} from "node:module";
import {setInterval, clearInterval} from "node:timers";
import {EventEmitter} from "node:events";

// 시험 소유 디렉터리의 두 번째 실제 open 완료만 보류한다. 원 I/O 결과는 바꾸지 않는다.
const directory = process.env.AGS_ROTATION_OPEN_GATE;
const open = fs.open;
const chained = process.env.AGS_ROTATION_REOPEN_CHAIN === "1";
let openings = 0;
if (directory) {
  let observedReopen;
  if (chained) {
    const emit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function (event, ...args) {
      if (event === "ready" && typeof this.file === "string"
        && this.file.startsWith(path.join(directory, "safe-"))) {
        observedReopen = this.reopen.bind(this);
        EventEmitter.prototype.emit = emit;
      }
      return emit.call(this, event, ...args);
    };
  }
  // 제품 listener보다 앞에서 입력 도착만 관측한다. ACK·저장 성공을 대신하지 않는다.
  if (process.env.AGS_ROTATION_INPUT_PROBE !== "0") process.on("message", message => {
    if (message?.id === 2 && message.category === "request") {
      process.send?.({fixture: "rotation-input-arrived", id: message.id});
    }
    if (message?.close === true) process.send?.({fixture: "rotation-close-arrived"});
  });
  fs.open = function (...args) {
    const file = String(args[0]);
    const callback = args.at(-1);
    if (file.startsWith(path.join(directory, "safe-")) && file.endsWith(".log")
      && typeof callback === "function" && (++openings === 2 || (chained && openings === 3))) {
      const opening = openings;
      args[args.length - 1] = (...result) => {
        fs.writeFileSync(path.join(directory, "open-held.tmp"), JSON.stringify({file: path.basename(file), error: result[0]?.code ?? null}), "utf8");
        fs.renameSync(path.join(directory, "open-held.tmp"), path.join(directory, "open-held"));
        process.send?.({fixture: "rotation-open-held", opening, file: path.basename(file), error: result[0]?.code ?? null});
        if (chained && opening === 2) {
          if (!observedReopen) throw new Error("ROTATION_FIXTURE_SINK_NOT_OBSERVED");
          // 실제 open 중 공개 reopen을 한 번 더 요청한다. 라이브러리의 ready listener가 다음 회전을 시작한다.
          observedReopen();
          process.send?.({fixture: "rotation-chained-reopen-returned"});
        }
        const timer = setInterval(() => {
          if (!fs.existsSync(path.join(directory, opening === 2 ? "release-open" : "release-open-3"))) return;
          clearInterval(timer);
          callback(...result);
          process.send?.({fixture: "rotation-open-released", opening});
        }, 5);
        timer.unref();
      };
    }
    return open.apply(this, args);
  };
  syncBuiltinESMExports();
}
