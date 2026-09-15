import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureStreamedEncryptedBackup,
  type StreamedEncryptedBackupCaptureSpec,
} from "../src/v3/backup.js";
import { inspectPhysicalTree } from "../src/v3/storage.js";

test("backup capture streams ciphertext into an independent receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "codefoldersync-streamed-backup-"));
  try {
    const runId = "streamed-backup-test";
    const source = join(root, "source", "Code");
    const sourceStaging = join(root, "source-staging");
    const receiptBase = join(root, "receipt-run");
    mkdirSync(join(source, "repo"), { recursive: true });
    mkdirSync(sourceStaging, { mode: 0o700 });
    mkdirSync(receiptBase, { mode: 0o700 });
    writeFileSync(join(sourceStaging, "SENTINEL"), `${runId}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(receiptBase, "SENTINEL"), `${runId}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      join(source, "repo", "index.ts"),
      "export const ok = true;\n",
    );

    const firstIdentity = join(root, "first.agekey");
    const secondIdentity = join(root, "second.agekey");
    run("age-keygen", ["--output", firstIdentity]);
    run("age-keygen", ["--output", secondIdentity]);
    const recipients = [
      run("age-keygen", ["--y", firstIdentity]).stdout.trim(),
      run("age-keygen", ["--y", secondIdentity]).stdout.trim(),
    ];

    const receiptSpecPath = join(root, "receipt.json");
    const receiptSpec = {
      schemaVersion: 1,
      runId,
      snapshotId: "snapshot-streamed",
      machineId: "wootbook",
      receiptBase,
      sessionDirectory: join(receiptBase, "incoming"),
      bundleDirectory: join(receiptBase, "bundle"),
      baselineAllocatedBytes: inspectPhysicalTree(receiptBase).allocatedBytes,
      projectedBytes: 10 * 1024 * 1024,
    };
    writeFileSync(receiptSpecPath, `${JSON.stringify(receiptSpec)}\n`, {
      mode: 0o600,
    });
    const cleanupSpecPath = join(root, "cleanup.json");
    writeFileSync(
      cleanupSpecPath,
      `${JSON.stringify({ schemaVersion: 1, runId, runRoot: receiptBase })}\n`,
      { mode: 0o600 },
    );
    const productCli = join(process.cwd(), "src", "product-cli.ts");
    const command = (...arguments_: string[]): readonly string[] => [
      process.execPath,
      "--import",
      "tsx",
      productCli,
      "acceptance",
      ...arguments_,
    ];
    const spec: StreamedEncryptedBackupCaptureSpec = {
      schemaVersion: 1,
      runId,
      snapshotId: "snapshot-streamed",
      machineId: "wootbook",
      sourcePlatform: "linux",
      sourceCodeRoot: source,
      stagingBase: sourceStaging,
      recipients,
      sourceStorageProfile: "mac-transient",
      receiptCommands: {
        archive: command(
          "receive-backup-artifact",
          "--spec",
          receiptSpecPath,
          "--artifact",
          "archive",
          "--approve",
        ),
        manifest: command(
          "receive-backup-artifact",
          "--spec",
          receiptSpecPath,
          "--artifact",
          "manifest",
          "--approve",
        ),
        witness: command(
          "receive-backup-witness",
          "--spec",
          receiptSpecPath,
          "--approve",
        ),
        finalize: command(
          "finalize-backup-receipt",
          "--spec",
          receiptSpecPath,
          "--approve",
        ),
        abort: command("cleanup-run", "--spec", cleanupSpecPath, "--approve"),
      },
    };
    const result = await captureStreamedEncryptedBackup(spec);
    assert.equal(result.passed, true);
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(readdirSync(sourceStaging), ["SENTINEL"]);
    assert.deepEqual(readdirSync(receiptSpec.bundleDirectory).sort(), [
      "witness.json",
      "wootbook-Code.tar.zst.age",
      "wootbook-manifest.ndjson.zst.age",
    ]);

    const failedReceiptBase = join(root, "failed-receipt-run");
    mkdirSync(failedReceiptBase, { mode: 0o700 });
    writeFileSync(join(failedReceiptBase, "SENTINEL"), `${runId}\n`, {
      mode: 0o600,
    });
    const failedCleanupSpec = join(root, "failed-cleanup.json");
    writeFileSync(
      failedCleanupSpec,
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        runRoot: failedReceiptBase,
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      captureStreamedEncryptedBackup({
        ...spec,
        snapshotId: "snapshot-failure",
        receiptCommands: {
          ...spec.receiptCommands,
          archive: ["/usr/bin/false"],
          abort: command(
            "cleanup-run",
            "--spec",
            failedCleanupSpec,
            "--approve",
          ),
        },
      }),
      /failed without publishing path details/u,
    );
    assert.deepEqual(readdirSync(sourceStaging), ["SENTINEL"]);
    assert.equal(existsSync(failedReceiptBase), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(
  command: string,
  arguments_: string[],
): { readonly stdout: string } {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout };
}
