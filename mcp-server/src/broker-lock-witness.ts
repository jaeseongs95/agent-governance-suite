import { closeSync, openSync } from "node:fs";
import net from "node:net";

/**
 * Windows 잠금 세대의 생존 증인. 소유자는 세대 이름의 named pipe를 listen한 채 잠금을 보유한다.
 * pipe는 소유 프로세스가 끝나면 OS가 즉시 없애므로 PID 재사용·시계·출생 시각 조회와 무관하다.
 * 다른 플랫폼은 기존 출생 시각 marker를 쓴다.
 */
export const lockWitnessSupported = (platform: NodeJS.Platform = process.platform) => platform === "win32";

const witnessPath = (generation: string) => "\\\\.\\pipe\\agent-governance-broker-lock-" + generation;

/**
 * pipe 바인드는 listen 호출 안에서 동기로 끝나므로 listening으로 바로 판정한다. 관측자와 같은 방식으로
 * 자기 pipe가 보여야만 증인으로 쓴다(격리 namespace 등). 아니면 null이고 호출자는 hash marker로 돌아간다.
 */
export function createLockWitness(generation: string): net.Server | null {
  // 증인은 이름의 존재만 쓴다. 들어온 연결은 읽지 않고 즉시 끊는다.
  const server = net.createServer(socket => { socket.destroy(); });
  server.on("error", () => { /* 바인드 실패는 아래 listening으로 판정한다. */ });
  server.listen(witnessPath(generation));
  if (!server.listening || lockWitnessState(generation) !== "present") { server.close(); return null; }
  server.unref();
  return server;
}

/** 목록 열거 대신 정확한 이름을 연다. ENOENT만 부재이고 열림·EBUSY(인스턴스 사용 중)는 존재, 그 밖은 판정 보류다. */
export function lockWitnessState(generation: string): "present" | "absent" | "unknown" {
  try { closeSync(openSync(witnessPath(generation), "r")); return "present"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" ? "absent" : code === "EBUSY" ? "present" : "unknown";
  }
}
