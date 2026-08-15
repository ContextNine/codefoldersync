export interface Lease {
  readonly repository: string;
  readonly holder: string;
  readonly baselineDigest: string;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class LeaseGuard {
  readonly #leases = new Map<string, Lease>();
  #epoch = 0;

  acquire(input: {
    readonly repository: string;
    readonly holder: string;
    readonly baselineDigest: string;
    readonly now: number;
    readonly ttlMs: number;
    readonly allPeersReady: boolean;
    readonly hasConflict: boolean;
  }): Lease {
    this.expire(input.now);
    if (!input.allPeersReady) throw new Error("guard-denied: peer-not-ready");
    if (input.hasConflict) throw new Error("guard-denied: conflict-present");
    if (input.baselineDigest.length === 0)
      throw new Error("guard-denied: missing-baseline");
    if (this.#leases.has(input.repository))
      throw new Error("guard-denied: repository-busy");
    const lease: Lease = {
      repository: input.repository,
      holder: input.holder,
      baselineDigest: input.baselineDigest,
      epoch: ++this.#epoch,
      issuedAt: input.now,
      expiresAt: input.now + input.ttlMs,
    };
    this.#leases.set(input.repository, lease);
    return lease;
  }

  heartbeat(
    lease: Lease,
    now: number,
    ttlMs: number,
    currentBaselineDigest: string,
  ): Lease {
    const current = this.#leases.get(lease.repository);
    if (current?.epoch !== lease.epoch || current.holder !== lease.holder) {
      throw new Error("guard-denied: lease-not-current");
    }
    if (now >= current.expiresAt) {
      this.#leases.delete(lease.repository);
      throw new Error("guard-denied: lease-expired");
    }
    if (current.baselineDigest !== currentBaselineDigest) {
      this.#leases.delete(lease.repository);
      throw new Error("guard-denied: baseline-moved");
    }
    const renewed = { ...current, expiresAt: now + ttlMs };
    this.#leases.set(lease.repository, renewed);
    return renewed;
  }

  release(lease: Lease): void {
    const current = this.#leases.get(lease.repository);
    if (current?.epoch !== lease.epoch || current.holder !== lease.holder) {
      throw new Error("guard-denied: lease-not-current");
    }
    this.#leases.delete(lease.repository);
  }

  expire(now: number): readonly Lease[] {
    const expired: Lease[] = [];
    for (const [repository, lease] of this.#leases) {
      if (now >= lease.expiresAt) {
        expired.push(lease);
        this.#leases.delete(repository);
      }
    }
    return expired;
  }

  active(): readonly Lease[] {
    return [...this.#leases.values()];
  }
}
