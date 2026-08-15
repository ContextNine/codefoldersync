import assert from "node:assert/strict";
import test from "node:test";
import { LeaseGuard } from "../src/guard.js";

const request = {
  repository: "atlas",
  holder: "alpha",
  baselineDigest: "baseline",
  now: 1_000,
  ttlMs: 100,
  allPeersReady: true,
  hasConflict: false,
} as const;

test("leases allow different repos and deny a second writer in one repo", () => {
  const guard = new LeaseGuard();
  guard.acquire(request);
  assert.throws(
    () => guard.acquire({ ...request, holder: "beta", now: 1_001 }),
    /repository-busy/,
  );
  guard.acquire({ ...request, repository: "birch", holder: "beta" });
  assert.equal(guard.active().length, 2);
});

test("peer uncertainty and baseline movement fail closed", () => {
  const guard = new LeaseGuard();
  assert.throws(
    () => guard.acquire({ ...request, allPeersReady: false }),
    /peer-not-ready/,
  );
  const lease = guard.acquire(request);
  assert.throws(
    () => guard.heartbeat(lease, 1_050, 100, "moved"),
    /baseline-moved/,
  );
  assert.equal(guard.active().length, 0);
});

test("expired leases cannot be renewed", () => {
  const guard = new LeaseGuard();
  const lease = guard.acquire(request);
  assert.throws(
    () => guard.heartbeat(lease, 1_100, 100, "baseline"),
    /lease-expired/,
  );
});
