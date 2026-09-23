"""Generate the synthetic R16-e vector from the committed VM R16-c producer fixture."""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: generate-R16-e-vm-source.py VM_REPOSITORY OUTPUT_JSON")
    vm_repository, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    sys.path.insert(0, str(vm_repository))
    from tests.test_engine_ags_approved_slot_producer import ApprovedSlotProducerTests

    case = ApprovedSlotProducerTests("test_current_core_snapshot_is_signed_for_control_invocation")
    case.setUp()
    try:
        case.register()
        signed = case.receiver.receipt
        body = json.loads(base64.urlsafe_b64decode(signed["body"] + "=" * (-len(signed["body"]) % 4)))
        vector = {
            "origin": "VM R16-c ApprovedSlotProducerTests synthetic fixture",
            "producerCommit": "e7721cbb7e370b77d200b000a1a6c4c87d72b020",
            "serverEpoch": case.receiver.epoch,
            "publicKeySpki": base64.b64encode(case.key.public_key().public_bytes(
                Encoding.DER, PublicFormat.SubjectPublicKeyInfo,
            )).decode("ascii"),
            "invocationId": case.receiver.invocation_id,
            "projectId": case.project_id,
            "taskId": case.task_id,
            "snapshotDigest": body["source"]["snapshot_digest"],
            "signedSource": signed,
        }
        output.write_bytes((json.dumps(vector, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    finally:
        case.tearDown()


if __name__ == "__main__":
    main()
