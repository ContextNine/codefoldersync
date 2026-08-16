import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProductConfig, ServiceStatus } from "./types.js";

export const productVersion = "0.2.0";

export interface ServiceOptions {
  readonly configPath: string;
  readonly executablePath: string;
  readonly scriptPath?: string;
  readonly definitionDirectory?: string;
  readonly activate?: boolean;
}

export function installSelf(input: {
  readonly builtDirectory: string;
  readonly installRoot?: string;
  readonly binaryDirectory?: string;
}): { readonly executable: string; readonly versionDirectory: string } {
  const installRoot = resolve(
    input.installRoot ?? join(homedir(), ".local", "lib", "codefoldersync"),
  );
  const binaryDirectory = resolve(
    input.binaryDirectory ?? join(homedir(), ".local", "bin"),
  );
  const versionDirectory = join(installRoot, productVersion);
  if (existsSync(versionDirectory))
    throw new Error(`CodeFolderSync ${productVersion} is already installed`);
  mkdirSync(dirname(versionDirectory), { recursive: true, mode: 0o700 });
  cpSync(resolve(input.builtDirectory), versionDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  mkdirSync(binaryDirectory, { recursive: true, mode: 0o755 });
  const executable = join(binaryDirectory, "codefoldersync");
  const temporary = `${executable}.tmp-${randomUUID()}`;
  writeFileSync(
    temporary,
    `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(
      join(versionDirectory, "product-cli.js"),
    )} "$@"\n`,
    { encoding: "utf8", mode: 0o755, flag: "wx" },
  );
  renameSync(temporary, executable);
  chmodSync(executable, 0o755);
  return { executable, versionDirectory };
}

export function activateInstalledVersion(input: {
  readonly version: string;
  readonly installRoot?: string;
  readonly binaryDirectory?: string;
}): { readonly executable: string; readonly versionDirectory: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.version))
    throw new Error("Installed version is invalid");
  const installRoot = resolve(
    input.installRoot ?? join(homedir(), ".local", "lib", "codefoldersync"),
  );
  const binaryDirectory = resolve(
    input.binaryDirectory ?? join(homedir(), ".local", "bin"),
  );
  const versionDirectory = join(installRoot, input.version);
  const script = join(versionDirectory, "product-cli.js");
  if (!existsSync(script))
    throw new Error(`Installed version is missing: ${input.version}`);
  mkdirSync(binaryDirectory, { recursive: true, mode: 0o755 });
  const executable = join(binaryDirectory, "codefoldersync");
  const temporary = `${executable}.tmp-${randomUUID()}`;
  writeFileSync(
    temporary,
    `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(script)} "$@"\n`,
    { encoding: "utf8", mode: 0o755, flag: "wx" },
  );
  renameSync(temporary, executable);
  chmodSync(executable, 0o755);
  return { executable, versionDirectory };
}

export function installedVersions(installRoot?: string): readonly string[] {
  const root = resolve(
    installRoot ?? join(homedir(), ".local", "lib", "codefoldersync"),
  );
  if (!existsSync(root)) return [];
  return (process.getBuiltinModule("node:fs") as typeof import("node:fs"))
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, entry.name, "product-cli.js")),
    )
    .map((entry) => entry.name)
    .sort();
}

export function installService(
  config: ProductConfig,
  options: ServiceOptions,
): ServiceStatus {
  const manager = serviceManager();
  if (manager === "unsupported")
    throw new Error("Service manager is unsupported");
  const definitionPath = serviceDefinitionPath(config, options);
  if (existsSync(definitionPath))
    throw new Error(`Service definition already exists: ${definitionPath}`);
  mkdirSync(dirname(definitionPath), { recursive: true, mode: 0o700 });
  const definition =
    manager === "launchd"
      ? launchdDefinition(config, options)
      : systemdDefinition(config, options);
  const temporary = `${definitionPath}.tmp-${randomUUID()}`;
  writeFileSync(temporary, definition, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (manager === "launchd") {
    const lint = spawnSync("plutil", ["-lint", temporary], {
      encoding: "utf8",
    });
    if (lint.status !== 0)
      throw new Error(`Invalid launchd plist: ${lint.stderr.trim()}`);
  }
  renameSync(temporary, definitionPath);
  if (options.activate !== false)
    activateService(manager, config, definitionPath);
  return serviceStatus(config, options);
}

export function serviceStatus(
  config: ProductConfig,
  options: ServiceOptions,
): ServiceStatus {
  const manager = serviceManager();
  const label = serviceLabel(config);
  const definitionPath = serviceDefinitionPath(config, options);
  if (manager === "unsupported") {
    return { installed: false, running: false, manager, label, definitionPath };
  }
  const running =
    manager === "launchd"
      ? spawnSync("launchctl", ["print", `${launchdDomain()}/${label}`], {
          stdio: "ignore",
        }).status === 0
      : spawnSync("systemctl", ["--user", "is-active", serviceUnit(config)], {
          stdio: "ignore",
        }).status === 0;
  return {
    installed: existsSync(definitionPath),
    running,
    manager,
    label,
    definitionPath,
  };
}

export function startService(
  config: ProductConfig,
  options: ServiceOptions,
): void {
  const manager = serviceManager();
  const definition = serviceDefinitionPath(config, options);
  if (!existsSync(definition)) throw new Error("Service is not installed");
  if (manager === "launchd") {
    run("launchctl", ["bootstrap", launchdDomain(), definition]);
  } else if (manager === "systemd") {
    run("systemctl", ["--user", "start", serviceUnit(config)]);
  } else {
    throw new Error("Service manager is unsupported");
  }
}

export function stopService(config: ProductConfig): void {
  const manager = serviceManager();
  if (manager === "launchd") {
    const result = spawnSync(
      "launchctl",
      ["bootout", `${launchdDomain()}/${serviceLabel(config)}`],
      {
        encoding: "utf8",
      },
    );
    if (
      result.status !== 0 &&
      !/Could not find service|No such process/iu.test(result.stderr)
    )
      throw new Error(`launchctl bootout failed: ${result.stderr.trim()}`);
  } else if (manager === "systemd") {
    const result = spawnSync(
      "systemctl",
      ["--user", "stop", serviceUnit(config)],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0 && !/not loaded|not found/iu.test(result.stderr))
      throw new Error(`systemctl stop failed: ${result.stderr.trim()}`);
  } else {
    throw new Error("Service manager is unsupported");
  }
}

export function restartService(config: ProductConfig): void {
  const manager = serviceManager();
  if (manager === "launchd") {
    run("launchctl", [
      "kickstart",
      "-k",
      `${launchdDomain()}/${serviceLabel(config)}`,
    ]);
  } else if (manager === "systemd") {
    run("systemctl", ["--user", "restart", serviceUnit(config)]);
  } else {
    throw new Error("Service manager is unsupported");
  }
}

export function uninstallService(
  config: ProductConfig,
  options: ServiceOptions,
): string {
  const definition = serviceDefinitionPath(config, options);
  stopService(config);
  if (serviceManager() === "systemd") {
    const disabled = spawnSync(
      "systemctl",
      ["--user", "disable", serviceUnit(config)],
      { encoding: "utf8" },
    );
    if (
      disabled.status !== 0 &&
      !/not loaded|not found|does not exist/iu.test(
        disabled.stderr || disabled.stdout,
      )
    )
      throw new Error(
        `systemctl disable failed: ${(disabled.stderr || disabled.stdout).trim()}`,
      );
  }
  if (!existsSync(definition)) return definition;
  const recovery = join(
    config.stateDir,
    "recovery",
    `service-${basename(definition)}-${randomUUID()}`,
  );
  mkdirSync(dirname(recovery), { recursive: true, mode: 0o700 });
  renameSync(definition, recovery);
  if (serviceManager() === "systemd")
    run("systemctl", ["--user", "daemon-reload"]);
  return recovery;
}

export function serviceLogPaths(config: ProductConfig): {
  readonly stdout: string;
  readonly stderr: string;
} {
  return {
    stdout: join(config.stateDir, "logs", "daemon.stdout.log"),
    stderr: join(config.stateDir, "logs", "daemon.stderr.log"),
  };
}

function launchdDefinition(
  config: ProductConfig,
  options: ServiceOptions,
): string {
  const logs = serviceLogPaths(config);
  const programArguments = [
    resolve(options.executablePath),
    ...(options.scriptPath === undefined ? [] : [resolve(options.scriptPath)]),
    "daemon",
    "--config",
    resolve(options.configPath),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(serviceLabel(config))}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WorkingDirectory</key><string>${xml(config.stateDir)}</string>
  <key>StandardOutPath</key><string>${xml(logs.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(logs.stderr)}</string>
</dict>
</plist>
`;
}

function systemdDefinition(
  config: ProductConfig,
  options: ServiceOptions,
): string {
  const logs = serviceLogPaths(config);
  const command = [
    resolve(options.executablePath),
    ...(options.scriptPath === undefined ? [] : [resolve(options.scriptPath)]),
    "daemon",
    "--config",
    resolve(options.configPath),
  ]
    .map(systemdEscape)
    .join(" ");
  return `[Unit]
Description=CodeFolderSync ${config.folderName}
After=network-online.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdEscape(config.stateDir)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${systemdEscape(logs.stdout)}
StandardError=append:${systemdEscape(logs.stderr)}

[Install]
WantedBy=default.target
`;
}

function activateService(
  manager: "launchd" | "systemd",
  config: ProductConfig,
  definition: string,
): void {
  if (manager === "launchd") {
    run("launchctl", ["bootstrap", launchdDomain(), definition]);
  } else {
    run("systemctl", ["--user", "link", definition]);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", serviceUnit(config)]);
  }
}

function serviceDefinitionPath(
  config: ProductConfig,
  options: ServiceOptions,
): string {
  const manager = serviceManager();
  if (options.definitionDirectory !== undefined) {
    return join(
      resolve(options.definitionDirectory),
      manager === "launchd"
        ? `${serviceLabel(config)}.plist`
        : serviceUnit(config),
    );
  }
  return manager === "launchd"
    ? join(
        homedir(),
        "Library",
        "LaunchAgents",
        `${serviceLabel(config)}.plist`,
      )
    : join(homedir(), ".config", "systemd", "user", serviceUnit(config));
}

function serviceManager(): ServiceStatus["manager"] {
  return platform() === "darwin"
    ? "launchd"
    : platform() === "linux"
      ? "systemd"
      : "unsupported";
}

function serviceLabel(config: ProductConfig): string {
  return `dev.codefoldersync.${config.folderId.replace(/[^A-Za-z0-9.-]/gu, "-")}`;
}

function serviceUnit(config: ProductConfig): string {
  return `codefoldersync-${config.folderId.replace(/[^A-Za-z0-9_.@-]/gu, "-")}.service`;
}

function launchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdEscape(value: string): string {
  if (/[\n\r\0]/u.test(value)) throw new Error("Unsafe systemd argument");
  return value.replaceAll("%", "%%").replaceAll(" ", "\\x20");
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
