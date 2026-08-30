#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

static int matches_target(int descriptor, const char *kind) {
  const char *configured_kind = getenv("CODEFOLDERSYNC_TEST_FS_FAULT");
  const char *match = getenv("CODEFOLDERSYNC_TEST_FS_MATCH");
  if (configured_kind == NULL || match == NULL || match[0] == '\0' ||
      strcmp(configured_kind, kind) != 0) {
    return 0;
  }

  char descriptor_path[64];
  char target[4096];
  int path_bytes = snprintf(descriptor_path, sizeof(descriptor_path),
                            "/proc/self/fd/%d", descriptor);
  if (path_bytes <= 0 || (size_t)path_bytes >= sizeof(descriptor_path)) {
    return 0;
  }
  ssize_t target_bytes = syscall(SYS_readlinkat, AT_FDCWD, descriptor_path,
                                 target, sizeof(target) - 1);
  if (target_bytes < 0) {
    return 0;
  }
  target[target_bytes] = '\0';
  return strstr(target, match) != NULL;
}

ssize_t write(int descriptor, const void *buffer, size_t bytes) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_write, descriptor, buffer, bytes);
}

ssize_t writev(int descriptor, const struct iovec *iov, int count) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_writev, descriptor, iov, count);
}

ssize_t pwrite(int descriptor, const void *buffer, size_t bytes,
               off_t offset) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_pwrite64, descriptor, buffer, bytes, offset);
}

ssize_t pwrite64(int descriptor, const void *buffer, size_t bytes,
                 off64_t offset) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_pwrite64, descriptor, buffer, bytes, offset);
}

ssize_t pwritev(int descriptor, const struct iovec *iov, int count,
                off_t offset) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_pwritev, descriptor, iov, count, offset, 0);
}

ssize_t pwritev64(int descriptor, const struct iovec *iov, int count,
                  off64_t offset) {
  if (matches_target(descriptor, "enospc-write")) {
    errno = ENOSPC;
    return -1;
  }
  return syscall(SYS_pwritev, descriptor, iov, count, offset, 0);
}

int fsync(int descriptor) {
  if (matches_target(descriptor, "eio-fsync")) {
    errno = EIO;
    return -1;
  }
  return syscall(SYS_fsync, descriptor);
}

int fdatasync(int descriptor) {
  if (matches_target(descriptor, "eio-fsync")) {
    errno = EIO;
    return -1;
  }
  return syscall(SYS_fdatasync, descriptor);
}
