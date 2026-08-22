import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalJson, hashText } from "../v2/hash.js";
import { compileIgnore, defaultIgnore } from "./ignore.js";
import {
  protocolVersion,
  schemaVersion,
  type HubConfig,
  type LifecycleMode,
  type PeerRecord,
  type ProductConfig,
  type UnsignedFolderConfig,
} from "./types.js";
import { verifyRoot } from "./paths.js";

export function defaultRoot(): string {
  return join(homedir(), "Code");
}

export function defaultConfigPath(root = defaultRoot()): string {
  return join(resolve(root), ".codefoldersync", "config.json");
}

export function defaultStateDir(folderId: string): string {
  return join(homedir(), ".local", "state", "codefoldersync", folderId);
}

export function parseHubSpec(
  value: string,
  command: readonly string[] = ["~/.local/bin/codefoldersync"],
): HubConfig {
  if (!value.startsWith("ssh://"))
    return { kind: "local", path: resolve(value) };
  const url = new URL(value);
  if (url.protocol !== "ssh:" || url.hostname.length === 0 || url.port)
    throw new Error(
      "SSH hub must use ssh://user@host/absolute/path without a port",
    );
  const username = decodeURIComponent(url.username);
  const host = username ? `${username}@${url.hostname}` : url.hostname;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) throw new Error("SSH hub path must be absolute");
  if (!/^[A-Za-z0-9_.@:-]+$/u.test(host))
    throw new Error("SSH host is invalid");
  if (
    command.length === 0 ||
    command.some((part) => part.length === 0 || part.includes("\0"))
  )
    throw new Error("Remote command is invalid");
  return { kind: "ssh", host, path, command: [...command] };
}

export function createAuthorityConfig(input: {
  readonly root: string;
  readonly stateDir?: string;
  readonly folderName: string;
  readonly peerName: string;
  readonly hub: HubConfig;
  readonly backupWitness?: string;
}): ProductConfig {
  const root = resolve(input.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  verifyRoot(root);
  const folderId = randomUUID();
  const stateDir = resolve(input.stateDir ?? defaultStateDir(folderId));
  ensureRuntimeLayout(root, stateDir);
  const authorityKeys = generateKey(stateDir, "authority");
  const peerKeys = generateKey(stateDir, "peer");
  const peerId = randomUUID();
  const ignore = ensureIgnore(root);
  const peer: PeerRecord = {
    peerId,
    peerName: input.peerName,
    role: "authority",
    root,
    publicKey: peerKeys.publicKey,
  };
  const unsigned: UnsignedFolderConfig = {
    schemaVersion,
    protocolVersion,
    revision: 1,
    folderId,
    folderName: input.folderName,
    root,
    stateDir,
    peerId,
    peerName: input.peerName,
    hub: input.hub,
    authority: { peerId, publicKey: authorityKeys.publicKey },
    peers: [peer],
    ignoreDigest: ignore.digest,
    lifecycle: "adoption",
    backupWitness: input.backupWitness ?? null,
    service: { intervalMs: 150, reconcileSeconds: 600 },
  };
  return signConfig(unsigned, authorityKeys.privateKey);
}

export interface PeerEnrollmentRequest {
  readonly folderId: string;
  readonly peer: PeerRecord;
  readonly signature: string;
}

export function createPeerEnrollmentRequest(input: {
  readonly folderId: string;
  readonly root: string;
  readonly stateDir: string;
  readonly peerName: string;
  readonly role?: "peer" | "hub";
}): PeerEnrollmentRequest {
  const root = resolve(input.root);
  const stateDir = resolve(input.stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  ensureRuntimeLayout(root, stateDir);
  const keys = generateKey(stateDir, "peer");
  const peer: PeerRecord = {
    peerId: randomUUID(),
    peerName: input.peerName,
    role: input.role ?? "peer",
    root,
    publicKey: keys.publicKey,
  };
  return {
    folderId: input.folderId,
    peer,
    signature: signPayload({ folderId: input.folderId, peer }, keys.privateKey),
  };
}

export function enrollPeer(
  config: ProductConfig,
  request: PeerEnrollmentRequest,
  privateKey = authorityPrivateKey(config),
): ProductConfig {
  assertAuthority(config);
  if (request.folderId !== config.folderId)
    throw new Error("Enrollment request belongs to another folder");
  if (
    !verifyPayload(
      { folderId: request.folderId, peer: request.peer },
      request.signature,
      request.peer.publicKey,
    )
  )
    throw new Error("Peer enrollment signature is invalid");
  if (
    config.peers.some(
      (peer) =>
        peer.peerId === request.peer.peerId ||
        peer.peerName === request.peer.peerName ||
        peer.root === request.peer.root,
    )
  )
    throw new Error("Peer enrollment conflicts with an existing peer");
  return reviseConfig(
    config,
    { peers: [...config.peers, request.peer] },
    privateKey,
  );
}

export function activatePeerProjection(
  accepted: ProductConfig,
  request: PeerEnrollmentRequest,
  stateDir: string,
): ProductConfig {
  verifyConfig(accepted);
  const peer = accepted.peers.find(
    (value) => value.peerId === request.peer.peerId,
  );
  if (peer === undefined || canonicalJson(peer) !== canonicalJson(request.peer))
    throw new Error(
      "Accepted configuration does not contain this peer request",
    );
  const privateKey = readFileSync(
    join(resolve(stateDir), "keys", "peer.pem"),
    "utf8",
  );
  const derivedPublic = createPublicKey(createPrivateKey(privateKey))
    .export({ type: "spki", format: "pem" })
    .toString();
  if (derivedPublic !== peer.publicKey)
    throw new Error("Local peer identity does not match enrollment");
  return projectConfigForPeer(accepted, peer.peerId, stateDir);
}

export function projectConfigForPeer(
  accepted: ProductConfig,
  peerId: string,
  stateDir?: string,
): ProductConfig {
  verifyConfig(accepted);
  const peer = accepted.peers.find((value) => value.peerId === peerId);
  if (peer === undefined) throw new Error(`Peer is not enrolled: ${peerId}`);
  return {
    ...accepted,
    root: peer.root,
    stateDir: resolve(stateDir ?? defaultStateDir(accepted.folderId)),
    peerId: peer.peerId,
    peerName: peer.peerName,
  };
}

export function reviseConfig(
  config: ProductConfig,
  changes: {
    readonly peers?: readonly PeerRecord[];
    readonly ignoreDigest?: string;
    readonly lifecycle?: LifecycleMode;
  },
  authorityPrivateKey: string,
): ProductConfig {
  verifyConfig(config);
  return signConfig(
    {
      ...withoutSignature(config),
      revision: config.revision + 1,
      ...(changes.peers === undefined ? {} : { peers: changes.peers }),
      ...(changes.ignoreDigest === undefined
        ? {}
        : { ignoreDigest: changes.ignoreDigest }),
      ...(changes.lifecycle === undefined
        ? {}
        : { lifecycle: changes.lifecycle }),
    },
    authorityPrivateKey,
  );
}

export function authorityPrivateKey(config: ProductConfig): string {
  assertAuthority(config);
  return readFileSync(join(config.stateDir, "keys", "authority.pem"), "utf8");
}

export function peerPrivateKey(config: ProductConfig): string {
  return readFileSync(join(config.stateDir, "keys", "peer.pem"), "utf8");
}

export function assertAuthority(config: ProductConfig): void {
  if (config.authority.peerId !== config.peerId)
    throw new Error("Operation requires the configuration authority");
}

export function signPayload(payload: unknown, privateKey: string): string {
  return sign(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    createPrivateKey(privateKey),
  ).toString("base64");
}

export function verifyPayload(
  payload: unknown,
  signature: string,
  publicKey: string,
): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    createPublicKey(publicKey),
    Buffer.from(signature, "base64"),
  );
}

export function verifyConfig(config: ProductConfig): void {
  if (
    config.schemaVersion !== schemaVersion ||
    config.protocolVersion !== protocolVersion
  )
    throw new Error("Configuration is not CodeFolderSync V3");
  if (!Number.isSafeInteger(config.revision) || config.revision < 1)
    throw new Error("Configuration revision is invalid");
  if (resolve(config.root) !== config.root)
    throw new Error("Configured root must be absolute");
  if (resolve(config.stateDir) !== config.stateDir)
    throw new Error("State directory must be absolute");
  if (inside(config.root, config.stateDir))
    throw new Error("State directory must be outside the synchronized root");
  const peer = config.peers.find((value) => value.peerId === config.peerId);
  if (peer === undefined) throw new Error("Local peer is not enrolled");
  if (peer.root !== config.root || peer.peerName !== config.peerName)
    throw new Error("Local projection does not match the enrolled peer");
  const ids = new Set<string>();
  for (const value of config.peers) {
    if (ids.has(value.peerId)) throw new Error("Duplicate peer ID");
    ids.add(value.peerId);
    if (resolve(value.root) !== value.root)
      throw new Error(`Peer root must be absolute: ${value.peerName}`);
  }
  if (!ids.has(config.authority.peerId))
    throw new Error("Authority peer is not enrolled");
  if (
    !verifyPayload(
      signedConfigPayload(config),
      config.signature,
      config.authority.publicKey,
    )
  )
    throw new Error("Configuration authority signature is invalid");
}

export function saveConfig(
  path: string,
  config: ProductConfig,
  readOnly = config.peerId !== config.authority.peerId,
): void {
  verifyConfig(config);
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, absolute);
  chmodSync(absolute, readOnly ? 0o400 : 0o600);
  const authorityPath = join(dirname(absolute), "authority.json");
  atomicText(
    authorityPath,
    `${JSON.stringify(config.authority, null, 2)}\n`,
    0o444,
  );
  const readme = join(dirname(absolute), "README.txt");
  if (!existsSync(readme))
    atomicText(
      readme,
      "CodeFolderSync V3 authority-controlled configuration. Do not edit target projections.\n",
      0o444,
    );
}

export function loadConfig(path = defaultConfigPath()): ProductConfig {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (typeof value !== "object" || value === null)
    throw new Error("Configuration must be an object");
  const config = value as ProductConfig;
  verifyConfig(config);
  return config;
}

export function ensureRuntimeLayout(root: string, stateDir: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  if (lstatSync(root).dev !== lstatSync(stateDir).dev)
    throw new Error("Root and state directory must be on the same filesystem");
  for (const value of [
    "objects",
    "staging",
    "adoption-recovery",
    "apply-recovery",
    "logs",
    "keys",
    "plans",
  ])
    mkdirSync(join(stateDir, value), { recursive: true, mode: 0o700 });
}

export function ensureIgnore(root: string): ReturnType<typeof compileIgnore> {
  const path = join(root, ".codefoldersyncignore");
  if (!existsSync(path))
    writeFileSync(path, defaultIgnore, { encoding: "utf8", mode: 0o600 });
  if (!lstatSync(path).isFile())
    throw new Error(".codefoldersyncignore must be a regular file");
  return compileIgnore(readFileSync(path, "utf8"));
}

export function signedConfigPayload(config: ProductConfig): unknown {
  return {
    schemaVersion: config.schemaVersion,
    protocolVersion: config.protocolVersion,
    revision: config.revision,
    folderId: config.folderId,
    folderName: config.folderName,
    hub: config.hub,
    authority: config.authority,
    peers: config.peers,
    ignoreDigest: config.ignoreDigest,
    lifecycle: config.lifecycle,
    backupWitness: config.backupWitness,
    service: config.service ?? null,
  };
}

function signConfig(
  config: UnsignedFolderConfig,
  privateKey: string,
): ProductConfig {
  const temporary = { ...config, signature: "" };
  return {
    ...config,
    signature: signPayload(signedConfigPayload(temporary), privateKey),
  };
}

function withoutSignature(config: ProductConfig): UnsignedFolderConfig {
  const { signature: _signature, ...unsigned } = config;
  return unsigned;
}

function generateKey(
  stateDir: string,
  name: string,
): { readonly privateKey: string; readonly publicKey: string } {
  const privatePath = join(stateDir, "keys", `${name}.pem`);
  const publicPath = join(stateDir, "keys", `${name}.pub.pem`);
  if (existsSync(privatePath) || existsSync(publicPath))
    throw new Error(`Refusing to replace existing ${name} identity`);
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(privatePath, pair.privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(publicPath, pair.publicKey, { mode: 0o644, flag: "wx" });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function inside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function atomicText(path: string, value: string, mode: number): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, value, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

export function ignoreDigest(source: string): string {
  return hashText(source.replaceAll("\r\n", "\n"));
}
