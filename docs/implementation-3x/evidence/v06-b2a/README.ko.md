# V06-b2a Windows staging 관측

`prepared.json`은 2026-09-24에 Windows x64에서 `scripts/qualification/v06-b2a-windows-stage.mjs`를 실제 입력으로 실행해 생성한 결과다. 상태 `PREPARED`는 사용자 쓰기 가능 격리 staging의 한 시점 검사 결과이며 보호 설치, DLL/loader closure, 운영 host 적격성을 뜻하지 않는다. 이 JSON 자체는 신뢰 anchor가 아니며 후속 installer가 **받은 archive·keyring·checksum·AGS package bytes를 독립 경로에서 재검증**해야 한다.

이 증거는 F03-b가 반영된 AGS source epoch `0aaa9b144cd07e05a242ec7b9c1b436510e1a309`의 package manifest digest에만 적용된다. F04/F05 등으로 공식 package bytes가 바뀌면 새 candidate epoch에서 pin, release ID, staging 증거를 다시 계산해야 한다.

## 입력 출처와 검증

- Node archive: [`node-v24.19.0-win-x64.zip`](https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip), SHA-256 `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`.
- Signed checksums: [SHASUMS256.txt](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt) SHA-256 `be0629ee2bcd8e40bb856abdd3407f0762101b76bd60a36b8867f637733631c0`, [detached signature](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt.sig) SHA-256 `801534e2d4c769c087e2e3eec89e879032872357e64e82336f86f03e72ece630`.
- [Node release keyring](https://github.com/nodejs/release-keys) commit `481637f813e912c4aa3622d7964ab426c97b8e8d`의 `gpg/pubring.kbx`, SHA-256 `610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00`. `gpgv`가 `VALIDSIG 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`을 반환했고, 이 fingerprint는 [Node 공식 release-key 목록](https://github.com/nodejs/node#release-keys)의 Antoine du Hamel 항목과 일치했다. 서명된 checksum의 Windows archive digest와 실제 archive bytes도 일치했다.
- 검증 도구: Git 배포판 `gpgv.exe` SHA-256 `f4d13204d77fdf63c02b0e6742230f83a833128c28f7b715709c2c63a96c427b`, Windows System32 `tar.exe` SHA-256 `4e598a8cec84af779e3377442fce2b94b976f614ed4c6e5a665e19308fd1e379`. producer는 두 tool bytes를 pin한다.
- AGS `host-integration.json` SHA-256 `c512498add740c23be75e643334b4a55429be873e06b54721e73954332e4457a`; artifact 176개를 manifest hash와 대조해 정확한 파일 집합으로 staging했다. archive에서 추출한 `node.exe`의 SHA-256은 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`이다.

producer는 읽은 checksum bytes를 그대로 `gpgv`에 전달하고, 서명된 digest와 일치한 archive bytes를 staging에 기록한다. staging archive digest를 확인한 뒤 `node.exe`를 추출하고, 끝에서 staging release bytes를 다시 검증한다. 사용자 쓰기 가능 staging에 대한 동시 변경 가능성은 남으므로 후속 installer는 이를 신뢰 근거로 쓰지 않고 독립 검증한다.

## 재현

정확한 네 입력 파일(`node-v24.19.0-win-x64.zip`, `SHASUMS256.txt`, `SHASUMS256.txt.sig`, `nodejs-release-keyring.kbx`)을 별도 입력 디렉터리에 둔 뒤, 현재 SHA의 AGS root와 새 격리 출력 디렉터리를 지정한다. Windows Git `gpgv.exe`와 System32 `tar.exe`의 경로는 실행 host에 맞춰 전달하지만 producer가 위 digest를 강제한다.

```text
node scripts/qualification/v06-b2a-windows-stage.mjs --input-dir <input-dir> --package-root <ags-root> --output-dir <new-stage-dir> --version 24.19.0 --gpgv <gpgv.exe> --tar <tar.exe>
```

현재 실행에서 release ID는 `d742360af64993481e1908fe7d17caa4949ba4cfac9f937fbb791bd866a3a2cc`으로 재계산됐다. 집중 검사에서는 실제 서명된 입력의 checksum, signature, archive, keyring을 각각 한 바이트 변조하거나 version을 잘못 지정했을 때 모두 거부했다. 추가 package 파일과 artifact 변조도 거부했다. 사용한 원본 archive와 staging package는 용량과 사용자 쓰기 가능 상태 때문에 Git에 넣지 않았다. 재현하려면 위 공식 입력을 새로 받아 동일한 검증을 수행한다.
