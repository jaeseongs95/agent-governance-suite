// B14-n-l Linux storage identity helper.
// Reads the B14-m identity (f_fsid, st_ino, name_to_handle_at handle) from one
// handle opened with openat2 and fails closed on anything it cannot prove.
// Output is one JSON line; qualification is always FIXTURE_ONLY because this
// helper never proves a protected installation.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#ifndef SYS_openat2
#define SYS_openat2 437
#endif

#define SCHEMA "AgsLinuxStorageIdentity.v1"
#define EXT4_MAGIC 0xEF53UL
#define FILEID_INO32_GEN 1
#define MAX_HANDLE 128
#define RESOLVE_FLAGS (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)

struct observed {
  unsigned long magic;
  uint32_t fsid[2];
  uint64_t inode;
  uint64_t links;
  unsigned int dev_major, dev_minor;
  int handle_type;
  unsigned int handle_bytes;
  unsigned char handle[MAX_HANDLE];
};

static int fail(int code, const char *status, const char *detail, int err) {
  printf("{\"schema\":\"" SCHEMA "\",\"status\":\"%s\",\"qualification\":\"FIXTURE_ONLY\","
         "\"code\":\"%s\",\"errno\":%d}\n", status, detail, err);
  return code;
}

static const char *fs_name(unsigned long magic) {
  switch (magic) {
    case EXT4_MAGIC: return "ext4";
    case 0x58465342UL: return "xfs";
    case 0x9123683EUL: return "btrfs";
    case 0x01021994UL: return "tmpfs";
    case 0x794C7630UL: return "overlayfs";
    case 0x9FA0UL: return "proc";
    case 0x6969UL: return "nfs";
    default: return "unknown";
  }
}

// Decision table shared by real observation and the classify fixture mode.
// Only ext4 is supported: its f_fsid comes from the superblock UUID and its
// FILEID_INO32_GEN handle carries the inode generation. Everything else,
// including XFS (f_fsid derived from the device number) and volatile or
// stacked file systems, is UNSUPPORTED until B14-n/o observes it.
static const char *classify(unsigned long magic, int handle_type, unsigned int handle_bytes,
                            const unsigned char *handle, uint64_t inode, uint32_t *generation,
                            const char **status) {
  uint32_t handle_inode, gen;
  if (magic != EXT4_MAGIC) { *status = "UNSUPPORTED_FILESYSTEM"; return "FILESYSTEM_NOT_ALLOWED"; }
  if (handle_type != FILEID_INO32_GEN || handle_bytes != 8) {
    *status = "BLOCKED_NO_GENERATION"; return "HANDLE_TYPE_WITHOUT_GENERATION";
  }
  memcpy(&handle_inode, handle, 4);
  memcpy(&gen, handle + 4, 4);
  if ((uint64_t)handle_inode != inode) { *status = "UNKNOWN"; return "HANDLE_INODE_MISMATCH"; }
  if (gen == 0) { *status = "BLOCKED_NO_GENERATION"; return "GENERATION_ZERO"; }
  *generation = gen;
  *status = "OBSERVED";
  return NULL;
}

static int open_beneath_root(int root, const char *path) {
  struct open_how how;
  memset(&how, 0, sizeof how);
  how.flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY | O_NONBLOCK;
  how.resolve = RESOLVE_FLAGS;
  return (int)syscall(SYS_openat2, root, path + 1, &how, sizeof how);
}

static int observe_fd(int fd, struct observed *out, const char **detail, int *err) {
  struct stat st;
  struct statfs sfs;
  struct file_handle *fh;
  int mount_id = -1;
  if (fstat(fd, &st) != 0) { *err = errno; *detail = "FSTAT_FAILED"; return -1; }
  if (!S_ISREG(st.st_mode)) { *err = 0; *detail = "NOT_REGULAR"; return -2; }
  if (fstatfs(fd, &sfs) != 0) { *err = errno; *detail = "FSTATFS_FAILED"; return -1; }
  fh = calloc(1, sizeof *fh + MAX_HANDLE);
  if (fh == NULL) { *err = ENOMEM; *detail = "ALLOCATION_FAILED"; return -1; }
  fh->handle_bytes = MAX_HANDLE;
  if (name_to_handle_at(fd, "", fh, &mount_id, AT_EMPTY_PATH) != 0) {
    *err = errno;
    *detail = (errno == EOPNOTSUPP || errno == ENOTSUP) ? "HANDLE_UNSUPPORTED" : "HANDLE_FAILED";
    free(fh);
    return (*err == EOPNOTSUPP || *err == ENOTSUP) ? -3 : -1;
  }
  memset(out, 0, sizeof *out);
  out->magic = (unsigned long)sfs.f_type;
  memcpy(out->fsid, &sfs.f_fsid, sizeof out->fsid);
  out->inode = (uint64_t)st.st_ino;
  out->links = (uint64_t)st.st_nlink;
  out->dev_major = major(st.st_dev);
  out->dev_minor = minor(st.st_dev);
  out->handle_type = fh->handle_type;
  out->handle_bytes = fh->handle_bytes;
  memcpy(out->handle, fh->f_handle, fh->handle_bytes);
  free(fh);
  return 0;
}

static int same_identity(const struct observed *a, const struct observed *b) {
  return a->magic == b->magic && a->fsid[0] == b->fsid[0] && a->fsid[1] == b->fsid[1] &&
         a->inode == b->inode && a->handle_type == b->handle_type &&
         a->handle_bytes == b->handle_bytes && memcmp(a->handle, b->handle, a->handle_bytes) == 0;
}

static void print_hex(const unsigned char *bytes, unsigned int length) {
  for (unsigned int i = 0; i < length; i++) printf("%02x", bytes[i]);
}

static int observe_path(const char *path) {
  struct observed first, second;
  const char *detail = NULL, *status = NULL, *blocked;
  uint32_t generation = 0;
  int err = 0, root, fd, again, rc;
  if (path[0] != '/' || path[1] == '\0' || strlen(path) >= 4096) return fail(1, "UNKNOWN", "INVALID_PATH", 0);
  root = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root < 0) return fail(1, "UNKNOWN", "ROOT_OPEN_FAILED", errno);
  fd = open_beneath_root(root, path);
  if (fd < 0) {
    err = errno;
    close(root);
    if (err == ELOOP) return fail(2, "BLOCKED_SYMLINK", "SYMLINK_IN_PATH", err);
    if (err == EXDEV) return fail(2, "BLOCKED_PATH", "ESCAPES_ROOT", err);
    if (err == ENOSYS || err == E2BIG) return fail(1, "UNKNOWN", "OPENAT2_UNAVAILABLE", err);
    return fail(1, "UNKNOWN", "OPEN_FAILED", err);
  }
  rc = observe_fd(fd, &first, &detail, &err);
  close(fd);
  if (rc == -2) { close(root); return fail(2, "BLOCKED_NOT_REGULAR", detail, err); }
  if (rc == -3) { close(root); return fail(2, "UNSUPPORTED_FILESYSTEM", detail, err); }
  if (rc != 0) { close(root); return fail(1, "UNKNOWN", detail, err); }
  // Re-resolve the path: a replacement between the two opens is not an identity.
  again = open_beneath_root(root, path);
  close(root);
  if (again < 0) return fail(2, "BLOCKED_PATH_CHANGED", "REOPEN_FAILED", errno);
  rc = observe_fd(again, &second, &detail, &err);
  close(again);
  if (rc != 0 || !same_identity(&first, &second)) return fail(2, "BLOCKED_PATH_CHANGED", "IDENTITY_CHANGED", 0);
  blocked = classify(first.magic, first.handle_type, first.handle_bytes, first.handle, first.inode,
                     &generation, &status);
  if (blocked != NULL) {
    printf("{\"schema\":\"" SCHEMA "\",\"status\":\"%s\",\"qualification\":\"FIXTURE_ONLY\","
           "\"code\":\"%s\",\"fileSystem\":{\"magic\":\"0x%lx\",\"name\":\"%s\"},\"handleType\":%d,"
           "\"handleBytes\":%u}\n", status, blocked, first.magic, fs_name(first.magic),
           first.handle_type, first.handle_bytes);
    return strcmp(status, "UNKNOWN") == 0 ? 1 : 2;
  }
  status = first.links == 1 ? "OBSERVED" : "BLOCKED_ALIAS";
  printf("{\"schema\":\"" SCHEMA "\",\"status\":\"%s\",\"qualification\":\"FIXTURE_ONLY\","
         "\"fileSystem\":{\"magic\":\"0x%lx\",\"name\":\"%s\"},\"fsid\":\"%08x%08x\","
         "\"inode\":\"%016llx\",\"generation\":\"%08x\",\"handleType\":%d,\"handleBytes\":%u,"
         "\"handle\":\"", status, first.magic, fs_name(first.magic), first.fsid[0], first.fsid[1],
         (unsigned long long)first.inode, generation, first.handle_type, first.handle_bytes);
  print_hex(first.handle, first.handle_bytes);
  printf("\",\"identity\":\"%08x%08x:%016llx:%08x:", first.fsid[0], first.fsid[1],
         (unsigned long long)first.inode, (unsigned int)first.handle_type);
  print_hex(first.handle, first.handle_bytes);
  printf("\",\"linkCount\":%llu,\"diagnostic\":{\"stDev\":\"%u:%u\"}}\n",
         (unsigned long long)first.links, first.dev_major, first.dev_minor);
  return first.links == 1 ? 0 : 2;
}

static int parse_hex(const char *text, unsigned char *out, unsigned int *length) {
  size_t size = strlen(text);
  if (size % 2 != 0 || size / 2 > MAX_HANDLE) return -1;
  for (size_t i = 0; i < size / 2; i++) {
    unsigned int byte;
    if (sscanf(text + 2 * i, "%2x", &byte) != 1) return -1;
    out[i] = (unsigned char)byte;
  }
  *length = (unsigned int)(size / 2);
  return 0;
}

// Fixture mode: runs the decision table on supplied values. It never reads a
// file and never prints an identity, so it cannot stand in for an observation.
static int classify_fixture(char **argv) {
  unsigned char handle[MAX_HANDLE];
  unsigned int handle_bytes = 0;
  const char *status = NULL, *code;
  uint32_t generation = 0;
  unsigned long magic = strtoul(argv[0], NULL, 16);
  int handle_type = (int)strtol(argv[1], NULL, 0);
  unsigned long long inode = strtoull(argv[3], NULL, 10);
  if (parse_hex(argv[2], handle, &handle_bytes) != 0) return fail(1, "UNKNOWN", "INVALID_FIXTURE", 0);
  code = classify(magic, handle_type, handle_bytes, handle, inode, &generation, &status);
  printf("{\"schema\":\"" SCHEMA "\",\"mode\":\"CLASSIFY_FIXTURE\",\"status\":\"%s\","
         "\"qualification\":\"FIXTURE_ONLY\",\"code\":%s%s%s}\n", status,
         code ? "\"" : "", code ? code : "null", code ? "\"" : "");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 6 && strcmp(argv[1], "--classify-fixture") == 0) return classify_fixture(argv + 2);
  if (argc != 2) return fail(1, "UNKNOWN", "USAGE", 0);
  return observe_path(argv[1]);
}
