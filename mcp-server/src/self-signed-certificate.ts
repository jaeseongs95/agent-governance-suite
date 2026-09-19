import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

function length(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x100) return Buffer.from([0x81, value]);
  return Buffer.from([0x82, value >> 8, value & 0xff]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const objectIdentifier = (hex: string) => tlv(0x06, Buffer.from(hex, "hex"));
const integer = (value: Buffer) => tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));

function certificateTime(value: Date): Buffer {
  const digits = value.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return value.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${digits}Z`));
}

const ECDSA_WITH_SHA256 = sequence(objectIdentifier("2a8648ce3d040302"));
const COMMON_NAME = sequence(tlv(0x31, sequence(objectIdentifier("550403"), utf8("agent-governance-suite local broker"))));

/** Creates the minimal portable X.509 material needed by the loopback TLS 1.3 broker. */
export function createSelfSignedCertificate(now = new Date()): { privateKeyPem: string; certificatePem: string; fingerprint256: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 5);
  const subjectAlternativeNames = sequence(
    tlv(0x82, Buffer.from("localhost", "ascii")),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = tlv(0xa3, sequence(sequence(
    objectIdentifier("551d11"),
    tlv(0x04, subjectAlternativeNames),
  )));
  const toBeSigned = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ECDSA_WITH_SHA256,
    COMMON_NAME,
    sequence(certificateTime(notBefore), certificateTime(notAfter)),
    COMMON_NAME,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const der = sequence(toBeSigned, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature));
  const encoded = der.toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { privateKeyPem, certificatePem, fingerprint256: new X509Certificate(certificatePem).fingerprint256 };
}
