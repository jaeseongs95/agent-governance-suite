"""Measure one isolated Linux Node candidate inside the pinned Docker image."""

import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import time
from pathlib import Path


def fail(message):
    raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_bytes(path):
    if not stat.S_ISREG(os.lstat(path).st_mode):
        fail(f"not a regular file: {path}")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        data = b"".join(iter(lambda: os.read(fd, 1024 * 1024), b""))
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
        ):
            fail(f"file changed while read: {path}")
        return data, before
    finally:
        os.close(fd)


def package_files(root, manifest_hash):
    data, _ = file_bytes(root / "host-integration.json")
    if digest(data) != manifest_hash:
        fail("host manifest digest mismatch")
    manifest = json.loads(data)
    if manifest.get("format") != "agent-governance-suite.host-integration.v1":
        fail("invalid host manifest")
    entries = manifest.get("entryPoints", [])
    if [entry.get("id") for entry in entries] != [
        "mcp-server", "scope-baseline", "scope-compare", "acceptance-cli"
    ]:
        fail("entry point set mismatch")
    expected = {"host-integration.json"}
    folded = {"host-integration.json"}
    for item in manifest.get("artifacts", []):
        name = item["path"]
        parts = name.split("/")
        if (not re.fullmatch(r"[A-Za-z0-9._/-]+", name) or any(
            part in ("", ".", "..") for part in parts
        ) or name.lower() in folded):
            fail(f"unsafe or duplicate package path: {name}")
        folded.add(name.lower())
        expected.add(name)
        target = root.joinpath(*parts)
        for parent in [root, *list(target.parents)[:-1]]:
            if parent == root.parent:
                break
            if parent.exists() and not stat.S_ISDIR(os.lstat(parent).st_mode):
                fail(f"unsafe package parent: {name}")
        content, _ = file_bytes(target)
        if item["sha256"] != f"sha256:{digest(content)}":
            fail(f"artifact digest mismatch: {name}")
    found = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            item = Path(directory) / name
            if stat.S_ISLNK(os.lstat(item).st_mode):
                fail(f"package symlink: {item}")
        for name in files:
            found.add((Path(directory) / name).relative_to(root).as_posix())
    if found != expected:
        fail("extra or missing package file")
    for entry in entries:
        if entry["path"] not in expected or any(
            name not in expected for name in entry["executionClosure"]
        ):
            fail("entry closure not in package")
    return manifest, expected


def elf_search_paths(data):
    if data[:6] != b"\x7fELF\x02\x01":
        fail("not a little-endian ELF64 executable")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    loads = []
    dynamic = None
    interpreter = None
    for index in range(phnum):
        kind, _, offset, vaddr, _, size, _, _ = struct.unpack_from(
            "<IIQQQQQQ", data, phoff + index * phsize
        )
        if kind == 1:
            loads.append((vaddr, vaddr + size, offset))
        elif kind == 2:
            dynamic = (offset, size)
        elif kind == 3:
            interpreter = data[offset:offset + size].rstrip(b"\0").decode()
    if interpreter != "/lib64/ld-linux-x86-64.so.2" or not os.path.realpath(interpreter).startswith("/usr/lib/"):
        fail("untrusted ELF interpreter")
    if dynamic is None:
        fail("missing ELF dynamic section")
    tags = []
    for offset in range(dynamic[0], dynamic[0] + dynamic[1], 16):
        tag, value = struct.unpack_from("<QQ", data, offset)
        if tag == 0:
            break
        tags.append((tag, value))
    strtab = next((value for tag, value in tags if tag == 5), None)
    if strtab is None:
        fail("missing ELF string table")
    table_offset = next(
        (offset + strtab - start for start, end, offset in loads if start <= strtab < end), None
    )
    if table_offset is None:
        fail("ELF string table outside load segments")
    search_paths = []
    for tag, value in tags:
        if tag in (15, 29):
            start = table_offset + value
            search_paths.append(data[start:data.index(b"\0", start)].decode())
    if search_paths:
        fail(f"ELF RPATH/RUNPATH present: {search_paths}")
    return interpreter, [
        data[table_offset + value:data.index(b"\0", table_offset + value)].decode()
        for tag, value in tags if tag == 1
    ]


def mounts():
    result = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        result.append((fields[4].replace("\\040", " "), int(fields[0]), fields[2]))
    return sorted(result, key=lambda item: len(item[0]), reverse=True)


def measured_mappings(maps, mount_table):
    mapped = {}
    for line in maps.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 6 or not parts[5].startswith("/"):
            continue
        name = parts[5]
        if name.endswith(" (deleted)"):
            fail(f"deleted loaded mapping: {name}")
        inode = int(parts[4])
        if not inode:
            continue
        data, info = file_bytes(name)
        major, minor = (int(piece, 16) for piece in parts[3].split(":"))
        if (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino) != (
            major, minor, inode
        ):
            fail(f"loaded file identity mismatch: {name}")
        mount = next(
            ((id_, device) for prefix, id_, device in mount_table if
             name == prefix or name.startswith(prefix.rstrip("/") + "/")), None
        )
        if mount is None:
            fail(f"loaded file mount unknown: {name}")
        mapped[name] = {
            "path": name, "sha256": digest(data), "device": info.st_dev,
            "inode": info.st_ino, "mountId": mount[0], "mountDevice": mount[1],
            "mode": oct(stat.S_IMODE(info.st_mode)), "uid": info.st_uid,
            "source": "candidate" if name.startswith(INSTALL_ROOT + "/") else "os-managed",
        }
    return sorted(mapped.values(), key=lambda item: item["path"])


def worker():
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)


def run_entry(node, entry, mount_table):
    argv = [str(node), "--no-addons", "--no-global-search-paths", str(entry), "--help"]
    process = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd="/", env={"LC_ALL": "C"}, preexec_fn=worker
    )
    observed = ""
    deadline = time.monotonic() + 0.7
    while time.monotonic() < deadline:
        try:
            current = Path(f"/proc/{process.pid}/maps").read_text()
            if len(current) > len(observed):
                observed = current
        except (FileNotFoundError, ProcessLookupError):
            break
        if process.poll() is not None:
            break
        time.sleep(0.002)
    if process.poll() is None:
        process.terminate()
    stdout, stderr = process.communicate(timeout=3)
    if not observed or str(node) not in observed:
        fail(f"entry mappings not observed: {entry}")
    return {
        "argv": argv, "exitCode": process.returncode,
        "stdoutSha256": digest(stdout), "stderrSha256": digest(stderr),
        "mappedFiles": measured_mappings(observed, mount_table),
    }


stage = Path("/stage")
version, archive_name, archive_hash, manifest_hash, release_id = sys.argv[1:]
INSTALL_ROOT = f"/usr/lib/agent-governance-suite/protected-runtime/{release_id}"
mount_root = Path("/usr/lib/agent-governance-suite/protected-runtime")
if not os.path.ismount(mount_root) or not re.fullmatch(r"[a-f0-9]{64}", release_id):
    fail("candidate tmpfs mount or release ID invalid")
archive = stage / archive_name
archive_data, _ = file_bytes(archive)
if digest(archive_data) != archive_hash:
    fail("staged archive digest mismatch")
manifest, names = package_files(stage / "package", manifest_hash)
root = Path(INSTALL_ROOT)
node = root / "bin/node"
node.parent.mkdir(parents=True)
with tarfile.open(fileobj=__import__("io").BytesIO(archive_data), mode="r:xz") as tar:
    member = tar.getmember(f"node-v{version}-linux-x64/bin/node")
    if not member.isfile() or member.size > 200 * 1024 * 1024 or not member.mode & 0o111:
        fail("invalid archive node member")
    node_bytes = tar.extractfile(member).read()
node.write_bytes(node_bytes)
interpreter, needed = elf_search_paths(node_bytes)
package_root = root / "package"
for name in sorted(names):
    target = package_root.joinpath(*name.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(file_bytes(stage / "package" / name)[0])
for directory, dirs, files in os.walk(root):
    for name in files:
        item = Path(directory) / name
        item.chmod(0o555 if item == node else 0o444)
    for name in dirs:
        (Path(directory) / name).chmod(0o555)
    Path(directory).chmod(0o555)
mount_root.chmod(0o555)
package_files(package_root, manifest_hash)
node_installed, node_stat = file_bytes(node)
if node_installed != node_bytes:
    fail("installed node differs from archive")
env = {"LC_ALL": "C"}
version_result = subprocess.run(
    [str(node), "--no-addons", "--no-global-search-paths", "--version"],
    capture_output=True, text=True, cwd="/", env=env, preexec_fn=worker, timeout=5
)
if version_result.returncode or version_result.stdout.strip() != f"v{version}":
    fail("Node version or flags failed")
write_result = subprocess.run(
    [str(node), "--no-addons", "--no-global-search-paths", "-e",
     "require('fs').writeFileSync(process.argv[1], 'tamper')", str(node)],
    capture_output=True, cwd="/", env=env, preexec_fn=worker, timeout=5
)
if write_result.returncode == 0 or digest(file_bytes(node)[0]) != digest(node_bytes):
    fail("unprivileged worker could mutate node")
probe = subprocess.run(
    [str(node), "--no-addons", "--no-global-search-paths", "-e",
     "const f=require('fs');console.log(JSON.stringify({version:process.version,execPath:process.execPath,execArgv:process.execArgv,maps:f.readFileSync('/proc/self/maps','utf8')}))"],
    capture_output=True, text=True, cwd="/", env=env, preexec_fn=worker, timeout=5
)
if probe.returncode:
    fail(f"Node maps probe failed: {probe.stderr[:200]}")
probe_data = json.loads(probe.stdout)
if probe_data["execPath"] != str(node) or probe_data["version"] != f"v{version}":
    fail("Node process image mismatch")
mount_table = mounts()
mapped = measured_mappings(probe_data["maps"], mount_table)
if not any(item["path"] == str(node) and item["inode"] == node_stat.st_ino for item in mapped):
    fail("Node image not mapped from installed file")
entries = {}
for entry in manifest["entryPoints"]:
    entries[entry["id"]] = run_entry(node, package_root / entry["path"], mount_table)
print(json.dumps({
    "status": "DOCKER_CANDIDATE_OBSERVED", "os": "linux", "arch": "x64",
    "kernel": os.uname().release, "libc": os.confstr("CS_GNU_LIBC_VERSION"),
    "releaseSha256": release_id, "installRoot": INSTALL_ROOT,
    "nodePath": str(node), "nodeSha256": digest(node_bytes),
    "nodeDevice": node_stat.st_dev, "nodeInode": node_stat.st_ino,
    "nodeMode": oct(stat.S_IMODE(node_stat.st_mode)), "nodeOwner": node_stat.st_uid,
    "elfInterpreter": interpreter, "elfNeeded": needed,
    "packageFiles": len(names), "mappedFiles": mapped, "entries": entries,
    "mountInfoSha256": digest(Path("/proc/self/mountinfo").read_bytes()),
}, sort_keys=True))
