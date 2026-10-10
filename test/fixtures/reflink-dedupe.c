#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

/* The caller supplies two run-owned ordinary files on its private filesystem. */
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  int source = open(argv[1], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  int target = open(argv[2], O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  struct stat before, after;
  if (source < 0 || target < 0 || fstat(source, &before) != 0 ||
      fstat(target, &after) != 0 || !S_ISREG(before.st_mode) ||
      !S_ISREG(after.st_mode) || before.st_dev != after.st_dev ||
      before.st_ino == after.st_ino || before.st_size <= 0 ||
      before.st_size != after.st_size) return 1;
  struct file_dedupe_range *request = calloc(
      1, sizeof(*request) + sizeof(struct file_dedupe_range_info));
  if (request == NULL) return 1;
  request->src_length = (unsigned long long)before.st_size;
  request->dest_count = 1;
  request->info[0].dest_fd = target;
  int result = ioctl(source, FIDEDUPERANGE, request);
  int passed = result == 0 && request->info[0].status == 0 &&
      request->info[0].bytes_deduped == request->src_length;
  if (passed) printf("{\"kernelVerifiedDeduplicatedBytes\":%llu}\n",
      (unsigned long long)request->info[0].bytes_deduped);
  free(request);
  close(source);
  close(target);
  return passed ? 0 : 1;
}
