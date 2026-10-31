import { readdirSync } from "node:fs";
import net from "node:net";

/**
 * Windows 잠금 세대의 생존 증인. 소유자는 세대 이름의 named pipe를 listen한 채 잠금을 보유한다.
 * pipe는 소유 프로세스가 끝나면 OS가 즉시 없애므로 PID 재사용·시계·출생 시각 조회와 무관하다.
 * 다른 플랫폼은 기존 출생 시각 marker를 쓴다.
 */
export const lockWitnessSupported = (platform: NodeJS.Platform = process.platform) => platform === "win32";

const witnessName = (generation: string) => "agent-governance-broker-lock-" + generation;

/** pipe 바인드는 listen 호출 안에서 동기로 끝나므로 listening으로 바로 판정한다. 실패하면 null이다. */
export function createLockWitness(generation: string): net.Server | null {
  // 증인은 이름의 존재만 쓴다. 들어온 연결은 읽지 않고 즉시 끊는다.
  const server = net.createServer(socket => { socket.destroy(); });
  server.on("error", () => { /* 바인드 실패는 아래 listening으로 판정한다. */ });
  server.listen("\\\\.\\pipe\\" + witnessName(generation));
  if (!server.listening) { server.close(); return null; }
  server.unref();
  return server;
}

export function lockWitnessState(generation: string): "present" | "absent" | "unknown" {
  let names: string[];
  try { names = readdirSync("//./pipe/"); } catch { return "unknown"; }
  return names.includes(witnessName(generation)) ? "present" : "absent";
}
