# A09 전송 검증 계약

## 입력 경계

- 작은 `CheckpointDelta.v1`만 구조화된 값으로 inline 전달한다. `verifyInlineCheckpointDelta`는 기존 4 KiB UTF-8 한도와 delta schema를 적용한다. 문자열, Base64, 텍스트 조각 배열을 이어 붙이는 입력 경로는 없다.
- 큰 checkpoint와 기타 자료는 기존 객체 또는 파일의 `ArtifactRefV1`로 전달한다. 호출자는 A03의 접근 검사로 허용된 참조에서 raw bytes를 읽어야 한다. 참조의 digest만으로 접근 권한이 생기지 않는다.
- `verifyTransportReadback`의 `expectedNamespace`와 codec은 신뢰된 caller가 정한다. 요청의 참조에서 기대 namespace를 복사하지 않는다.

## 검증 순서

1. 참조 schema와 기대 namespace, `raw-bytes` hashDomain을 확인한다.
2. readback이 단일 `Uint8Array`인지 확인하고 복제한다. `ArtifactRefV1.size`와 SHA-256 digest를 복제한 실제 bytes에 대조한다. 압축 자료는 **압축된 bytes**를 먼저 대조한다.
3. 위 검사가 모두 통과한 뒤에만 `decompress`를 호출한다. `gzip`은 신뢰된 manifest의 raw 길이·SHA-256 digest가 필수다. 압축 해제 결과도 복제한 다음 raw 길이·digest를 대조하고, 그 후에만 `decode`를 호출한다.
4. 손상된 압축 bytes, 길이·namespace·hashDomain 불일치 시 두 콜백은 호출하지 않는다. raw digest 불일치 시 `decode`는 호출하지 않는다. 호출자는 압축 해제 출력 한도를 codec에서 적용하고, 해석 전 해당 자료의 schema·binding을 검사한다.

이 모듈은 검증된 참조 readback의 해석 순서와 inline delta 크기를 정한다. A08 snapshot resync의 실제 caller에 이 검증기를 우회 없이 연결하고 parser 이전에 적용하는 검증은 A11 범위다. 기존 메시지 크기를 늘리거나 손상된 문자열을 추정 복구하지 않는다.
