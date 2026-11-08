/**
 * In-memory connection concurrency tracker.
 *
 * Tracks live in-flight requests per connection so that account selection
 * (fill-first, round-robin, session-affinity, cost-optimized) dynamically
 * distributes parallel agent traffic across healthy sibling accounts in the pool
 * instead of saturating a single account and triggering upstream rate limits (429)
 * or socket disconnects (499).
 */

const inFlightByConnection = new Map<string, number>();

/**
 * Returns the number of currently active in-flight requests on the specified connection.
 */
export function getConnectionInFlight(connectionId: string | null | undefined): number {
  if (!connectionId) return 0;
  return inFlightByConnection.get(connectionId) ?? 0;
}

/**
 * Acquires a concurrency slot for the connection and returns an idempotent release callback.
 */
export function acquireConnectionFlight(connectionId: string | null | undefined): () => void {
  if (!connectionId) return () => {};

  const current = inFlightByConnection.get(connectionId) ?? 0;
  inFlightByConnection.set(connectionId, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const val = inFlightByConnection.get(connectionId) ?? 1;
    if (val <= 1) {
      inFlightByConnection.delete(connectionId);
    } else {
      inFlightByConnection.set(connectionId, val - 1);
    }
  };
}

/**
 * Sorts connections by:
 * 1. Active in-flight requests ascending (idle accounts first)
 * 2. Priority ascending (lower priority number = preferred)
 */
export function sortByLeastInFlight<T extends { id: string; priority?: number | null }>(
  connections: T[]
): T[] {
  return [...connections].sort((a, b) => {
    const aFlight = getConnectionInFlight(a.id);
    const bFlight = getConnectionInFlight(b.id);
    if (aFlight !== bFlight) return aFlight - bFlight;
    return (a.priority || 999) - (b.priority || 999);
  });
}

/**
 * Finds the connection with the lowest in-flight count.
 */
export function getLeastInFlightConnection<T extends { id: string }>(
  connections: T[]
): T | undefined {
  if (connections.length === 0) return undefined;
  let best = connections[0];
  let minFlight = getConnectionInFlight(best.id);

  for (let i = 1; i < connections.length; i++) {
    const flight = getConnectionInFlight(connections[i].id);
    if (flight < minFlight) {
      best = connections[i];
      minFlight = flight;
      if (minFlight === 0) break; // Found an idle connection
    }
  }

  return best;
}

/**
 * Reset all active in-flight tracking (useful for unit tests).
 */
export function resetConnectionConcurrencyTracker(): void {
  inFlightByConnection.clear();
}
