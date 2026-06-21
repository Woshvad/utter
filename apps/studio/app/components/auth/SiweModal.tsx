// SiweModal - the STU-05 connect-wallet -> sign SIWE login modal (D-STU-05).
//
// The browser does the signing: it builds the EIP-4361 message (embedding the
// server-issued nonce passed in via props) and calls wagmi's signMessage (personal_
// sign). Only the message string + signature are POSTed back to /auth - a private key
// NEVER reaches the server. The modal wraps the Plan-02 bordered + scrim Modal and
// exposes one primary action ("connect & sign") with connect/signing/error/success
// states.
//
// chainId + domain come from the chain object / server nonce, never a hand-written
// literal in the signing path. The nonce is the server-issued one-time token; the
// SiweMessage binds it (the replay guard, enforced server-side on verify).
import * as React from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";
import { arcTestnet } from "@utter/chain";
import { Modal } from "../primitives/Modal.js";

export interface SiweModalProps {
  open: boolean;
  onClose: () => void;
  /** The server-issued one-time nonce to embed in the signed message. */
  nonce: string;
  /** Whether the parent is mid-submit (verify in flight). */
  busy?: boolean;
  /** Called with the signed {message, signature} for the parent to POST to /auth. */
  onSign: (message: string, signature: string) => void;
}

type Phase = "connect" | "signing" | "error" | "success";

export function SiweModal({
  open,
  onClose,
  nonce,
  busy = false,
  onSign,
}: SiweModalProps): React.ReactElement {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = React.useState<Phase>("connect");
  const [error, setError] = React.useState<string | null>(null);

  const onConnectAndSign = React.useCallback(async () => {
    setError(null);
    try {
      // 1. connect the injected wallet if not already connected
      let signer = address;
      if (!isConnected) {
        const connector = connectors[0];
        if (!connector) throw new Error("no wallet connector available");
        connect({ connector });
        // the account hook updates async; the user re-clicks once connected, or the
        // address from the connect result is picked up on the next render
      }
      if (!signer && !isConnected) {
        // not yet connected; surface a connect-first state without erroring hard
        return;
      }
      signer = signer ?? address;
      if (!signer) return;

      // 2. build the EIP-4361 message embedding the server nonce + bound domain
      setPhase("signing");
      const domain = typeof window !== "undefined" ? window.location.host : "localhost";
      const uri = typeof window !== "undefined" ? window.location.origin : `https://${domain}`;
      const siwe = new SiweMessage({
        domain,
        address: signer,
        statement: "Sign in to Utter Studio",
        uri,
        version: "1",
        chainId: arcTestnet.id, // from the chain object, not a literal
        nonce,
      });
      const message = siwe.prepareMessage();

      // 3. the browser signs (personal_sign); only message+signature leave the client
      const signature = await signMessageAsync({ message });
      setPhase("success");
      onSign(message, signature);
    } catch (e) {
      setPhase("error");
      // Surface a short, non-secret message only (never the signature or a stack).
      setError(e instanceof Error ? e.message : "sign-in failed");
    }
  }, [address, isConnected, connect, connectors, nonce, signMessageAsync, onSign]);

  const label = busy || phase === "signing" ? "signing…" : isConnected ? "sign in" : "connect & sign";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="sign in"
      description="connect your wallet and sign a one-time message. no password, no private key leaves your wallet."
      footer={
        <button
          type="button"
          data-testid="siwe-connect-sign"
          onClick={() => void onConnectAndSign()}
          disabled={busy || phase === "signing"}
          className="border border-blue bg-blue px-md py-xs font-mono text-caption-mono text-paper outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-yellow disabled:opacity-50 lowercase"
        >
          {label}
        </button>
      }
    >
      <div className="flex flex-col gap-xs">
        {isConnected && address ? (
          <span data-testid="siwe-account" className="font-mono text-caption-mono text-ink-muted">
            {`${address.slice(0, 6)}…${address.slice(-4)}`}
          </span>
        ) : (
          <span className="font-mono text-caption-mono text-ink-faint lowercase">
            no wallet connected
          </span>
        )}
        {phase === "error" && error ? (
          <span
            data-testid="siwe-error"
            role="alert"
            className="border border-red px-xs py-2xs font-mono text-caption-mono text-red"
          >
            {error}
          </span>
        ) : null}
        {phase === "success" ? (
          <span data-testid="siwe-success" className="font-mono text-caption-mono text-yellow">
            signed — verifying…
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
