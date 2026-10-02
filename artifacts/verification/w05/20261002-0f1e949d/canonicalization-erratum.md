# Generated15 canonicalization metadata erratum

This append-only erratum clarifies the frozen generated15 seal at commit 9dc2ebd8b75aff2413240f42238d59e871a5eec8. The original seal, original 75 artifacts and original 7 supplement files remain byte-identical. No root 15 pins, source25 comparison, full Claude 507 manifest, source 1846 inventory, product test/build, controlled-clock diagnostic or source file is changed. This is separate from the unpublished private harness preparation and creates no execution or acceptance GO.

The frozen canonicalPayloadEncoding says “JSON sorted keys, compact separators, ensure_ascii=true; sealCanonicalSha256 field excluded.” The actual producer first computes sha(canonical(sealPayload)), then adds canonicalPayloadEncoding and sealCanonicalSha256 as envelope fields. Therefore the recorded payload digest excludes BOTH fields. The descriptor omitted the first exclusion; the emitted digest matches its actual payload definition.

For both definitions, parse the exact frozen JSON; recursively sort object keys; use compact separators comma/colon, ensure_ascii=true, UTF-8, and no trailing newline.

| Definition | Excluded top-level fields | Canonical bytes | SHA-256 |
| --- | --- | ---: | --- |
| Actual producer payload and recorded seal | canonicalPayloadEncoding, sealCanonicalSha256 | 14707 | `2f153df7ffeb580ceccc23f4c07030c1d72370efd3dc0677e037e106fca054e7` |
| Envelope comparison retaining encoding metadata | sealCanonicalSha256 only | 14828 | `e966b726499763061ced90f802dc3924dcffd8a11e1e3e98d946d8672ce9d0dd` |

The second digest is a comparison definition, not a replacement seal. The pretty-printed frozen file, including its trailing newline, independently retains transport SHA-256 `e7caf127f6274917249ba78560ad89fa8156d18b7c74a96c3bd2bc3ad7648d3f`. Payload digest, envelope comparison digest and transport-file digest are distinct definitions.

The producer was inspected directly: its canonical function uses json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode(), and its envelope assignment hashes sealPayload before adding the description and digest fields. The exact frozen bytes independently reproduce both definitions. [Machine-readable erratum](canonicalization-erratum.json) records exclusions, lengths and hashes. [Original seal](generated15-subset-seal.json), [original supplement](SUPPLEMENT.md) and both earlier manifests remain unchanged.

This clarification does not classify the original queued/held cause, relax expectations, pass the failed suite, or cover separate B14 audits.
