// useReceiptWait.ts - bridge wagmi's useWaitForTransactionReceipt (a query hook)
// into an awaitable "wait for THIS hash to confirm" function, so a multi-step
// signing flow (approve -> deposit) can await each receipt before sending the next
// tx while still exposing the hook's `confirming` flag to the UI.
//
// The hook owns the hash it is currently watching. Callers set the hash (setHash),
// then await waitFor(hash); the bridge resolves when useWaitForTransactionReceipt
// reports success for that hash and rejects on failure. Tests mock
// useWaitForTransactionReceipt to return a settled status, which drives the bridge
// deterministically with no chain.
import * as React from "react";
import { useWaitForTransactionReceipt } from "wagmi";

export interface ReceiptWait {
  /** The hash currently being watched, or undefined. */
  hash?: `0x${string}`;
  /** Point the watcher at a new hash (clears any prior settled state). */
  setHash: (hash: `0x${string}` | undefined) => void;
  /** Resolve when `hash` confirms (success) / reject on failure. */
  waitFor: (hash: `0x${string}`) => Promise<void>;
  /** True while the watched tx is being mined. */
  confirming: boolean;
}

interface Pending {
  hash: `0x${string}`;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Bridge useWaitForTransactionReceipt into an imperative waitFor(hash). The effect
 * settles the pending promise when the hook reports success/failure for the matching
 * hash. There is no money scaling here - it only tracks tx confirmation.
 */
export function useReceiptWait(): ReceiptWait {
  const [hash, setHashState] = React.useState<`0x${string}` | undefined>(undefined);
  const pendingRef = React.useRef<Pending | undefined>(undefined);

  const { data, isSuccess, isError, error, isLoading } = useWaitForTransactionReceipt({ hash });

  const setHash = React.useCallback((next: `0x${string}` | undefined) => {
    setHashState(next);
  }, []);

  const waitFor = React.useCallback((target: `0x${string}`): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      pendingRef.current = { hash: target, resolve, reject };
    });
  }, []);

  React.useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || pending.hash !== hash) return;
    if (isSuccess && data) {
      // A reverted tx confirms with status "reverted"; treat that as a failure.
      const status = (data as { status?: string }).status;
      if (status === "reverted") {
        pendingRef.current = undefined;
        pending.reject(new Error("transaction reverted"));
        return;
      }
      pendingRef.current = undefined;
      pending.resolve();
    } else if (isError) {
      pendingRef.current = undefined;
      pending.reject(error instanceof Error ? error : new Error("receipt failed"));
    }
  }, [hash, data, isSuccess, isError, error]);

  return { hash, setHash, waitFor, confirming: isLoading };
}
