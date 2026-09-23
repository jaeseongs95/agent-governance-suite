"""Run with the pinned FlowMarshal checkout on PYTHONPATH to refresh the V03 fixture."""
import base64
import json
import sys
from datetime import datetime
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from flowmarshal.engine.ags_observation_producer import AGSObservationProducer
from tests.test_engine_ags_observation_producer import FIXTURE, _issue, _service


example = FIXTURE["validCases"][0]
service, connection, ref = _service(example)
usage = json.loads(connection.execute("SELECT payload_json FROM budget_usage").fetchone()[0])
usage["recorded_at"] = "2026-09-23T00:00:05.000500+00:00"
connection.execute("UPDATE budget_usage SET payload_json=?", (json.dumps(usage),))
connection.commit()
key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex("01" * 32))
producer = AGSObservationProducer(
    private_key=key, installation_id=example["producer"]["installationId"],
    key_id=example["producer"]["keyId"], instance_id=example["producer"]["instanceId"],
    session_id=example["binding"]["sessionId"],
    clock=lambda: datetime.fromisoformat("2026-09-23T00:00:05.000900+00:00"),
    nonce=lambda: example["nonce"], invocation_id=lambda: example["binding"]["invocationId"],
)
receipt = _issue(example, producer, service, ref)
fixture = {
    "fixtureOnly": True, "source": "FlowMarshal VM producer 2deb96e; synthetic Core rows; no live provider",
    "receipt": receipt,
    "publicKeySpki": base64.b64encode(producer.public_key_spki()).decode("ascii"),
    "installationId": example["producer"]["installationId"],
    "hostId": example["producer"]["hostId"],
    "tool": example["invocation"]["tool"],
    "arguments": {**example["invocation"]["input"], "_hostAttestation": receipt},
    "binding": example["binding"], "now": "2026-09-23T00:00:05.001Z",
}
Path(sys.argv[1]).write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
connection.close()
