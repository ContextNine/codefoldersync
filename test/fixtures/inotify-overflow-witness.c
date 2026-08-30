#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/inotify.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: inotify-overflow-witness <directory>\n");
    return 64;
  }

  int descriptor = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
  if (descriptor < 0) {
    perror("inotify_init1");
    return 1;
  }
  if (inotify_add_watch(descriptor, argv[1], IN_ALL_EVENTS) < 0) {
    perror("inotify_add_watch");
    close(descriptor);
    return 1;
  }

  printf("READY\n");
  fflush(stdout);
  char trigger;
  if (read(STDIN_FILENO, &trigger, 1) != 1) {
    fprintf(stderr, "missing trigger\n");
    close(descriptor);
    return 1;
  }
  usleep(50000);

  char buffer[64 * 1024];
  long events = 0;
  int overflow = 0;
  for (;;) {
    ssize_t bytes = read(descriptor, buffer, sizeof(buffer));
    if (bytes < 0) {
      if (errno == EAGAIN) {
        break;
      }
      perror("read");
      close(descriptor);
      return 1;
    }
    for (char *cursor = buffer; cursor < buffer + bytes;) {
      struct inotify_event *event = (struct inotify_event *)cursor;
      events += 1;
      if ((event->mask & IN_Q_OVERFLOW) != 0) {
        overflow = 1;
      }
      cursor += sizeof(struct inotify_event) + event->len;
    }
  }
  close(descriptor);
  printf("OVERFLOW=%d EVENTS=%ld\n", overflow, events);
  return overflow ? 0 : 2;
}
