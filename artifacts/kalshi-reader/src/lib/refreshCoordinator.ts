/**
 * Ensures callers sharing a refresh trigger use one request instead of issuing
 * overlapping network fan-outs. A failed refresh is released immediately so a
 * later interval or manual action can retry.
 */
export function createRefreshCoordinator() {
  let inFlight: Promise<void> | null = null;

  return {
    run(refresh: () => Promise<void>): Promise<void> {
      if (inFlight) return inFlight;

      const request = refresh();
      inFlight = request;
      void request.then(
        () => {
          if (inFlight === request) inFlight = null;
        },
        () => {
          if (inFlight === request) inFlight = null;
        },
      );
      return request;
    },
  };
}