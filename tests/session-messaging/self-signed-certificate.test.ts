import { X509Certificate } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const serials = vi.hoisted(() => [
  Buffer.from("007fffffffffffffffffffffffffffff", "hex"),
  Buffer.from("80ffffffffffffffffffffffffffffff", "hex"),
  Buffer.alloc(16),
]);

vi.mock("node:crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomBytes: vi.fn(() => serials.shift()),
}));

import { createSelfSignedCertificate } from "../../mcp-server/src/self-signed-certificate.js";

describe("self-signed certificate", () => {
  it("encodes random serial numbers as canonical positive DER integers", () => {
    expect(["7FFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "80FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "01"])
      .toEqual(Array.from({ length: 3 }, () => {
        const { certificatePem } = createSelfSignedCertificate(new Date("2026-09-20T00:00:00Z"));
        return new X509Certificate(certificatePem).serialNumber;
      }));
  });
});
