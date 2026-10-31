import { readFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { SESSION_MESSAGE_PROTOCOL } from "../../../mcp-server/src/session-message-client.js";

export interface OwnedBrokerResponse { ok: boolean; data?: unknown; error?: string }
export type OwnedRequestState = "connecting" | "written" | "replied" | "closed" | "failed";

/**
 * One authenticated request to an owned d0254 fixture broker, without the product client's 2.5 s request cap.
 * It settles on the broker reply or on the connection's own end; no timer in this helper decides an outcome.
 * Authenticated own loopback fixture. Never log the frame, key, token, or native stderr.
 */
export function sendOwnedBrokerRequest(stateDirectory: string, operation: string, payload: Record<string, unknown>,
  frame: Record<string, unknown> = {}) {
  const endpoint = JSON.parse(readFileSync(path.join(stateDirectory, "endpoint.json"), "utf8")) as { port: number };
  const token = readFileSync(path.join(stateDirectory, "broker.token"), "utf8").trim();
  const socket = tls.connect({ host: "127.0.0.1", port: endpoint.port, servername: "localhost",
    ca: readFileSync(path.join(stateDirectory, "broker-cert.pem")), rejectUnauthorized: true });
  let state: OwnedRequestState = "connecting";
  const settled = () => state === "replied" || state === "closed" || state === "failed";
  const response = new Promise<OwnedBrokerResponse | Error>(resolve => {
    let data = "";
    const done = (next: OwnedRequestState, value: OwnedBrokerResponse | Error) => {
      if (settled()) return;
      state = next;
      socket.destroy();
      resolve(value);
    };
    socket.once("secureConnect", () => {
      socket.write(JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload, ...frame }) + "\n");
      if (state === "connecting") state = "written";
    });
    socket.on("data", chunk => {
      data += String(chunk);
      if (data.length > 8192) return done("failed", new Error("Owned fixture response exceeded its bound."));
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try { done("replied", JSON.parse(data.slice(0, newline)) as OwnedBrokerResponse); }
      catch (error) { done("failed", error instanceof Error ? error : new Error("Owned fixture response was not JSON.")); }
    });
    socket.on("error", error => done("failed", error));
    socket.once("close", () => done("closed", new Error("The owned broker connection closed before a complete response.")));
  });
  return { response, state: () => state, settled, destroy: () => { socket.destroy(); } };
}

/** The product client's result shape: reply data, or an Error for a rejection or a lost reply. */
export function brokerData(response: Promise<OwnedBrokerResponse | Error>): Promise<unknown> {
  return response.then(value => value instanceof Error ? value
    : value.ok ? value.data : new Error(value.error ?? "The broker rejected the request."));
}
