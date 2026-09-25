interface TargetLeaseSnapshot {
  readonly fencingToken: number;
  readonly busy: boolean;
}

/**
 * Share one instance between memory sync and companion stores for a target.
 * Readers and claims are synchronous, so checking the shared fence and setting
 * the winning lease cannot interleave on the JavaScript event loop.
 */
export class MemoryTargetLeaseCoordinator {
  private readonly readers: Array<(targetId: string, now: string) => TargetLeaseSnapshot> = [];

  register(read: (targetId: string, now: string) => TargetLeaseSnapshot): void {
    this.readers.push(read);
  }

  read(targetId: string, now: string): TargetLeaseSnapshot {
    let fencingToken = 0;
    let busy = false;
    for (const read of this.readers) {
      const snapshot = read(targetId, now);
      fencingToken = Math.max(fencingToken, snapshot.fencingToken);
      busy ||= snapshot.busy;
    }
    return { fencingToken, busy };
  }
}
