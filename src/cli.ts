#!/usr/bin/env node

const [command] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help") {
  process.stdout.write(
    `TreeSync safety harness\n\nCommands are implemented in the next phase.\n`,
  );
  process.exit(0);
}

process.stderr.write(`Unknown command: ${command}\n`);
process.exit(2);
