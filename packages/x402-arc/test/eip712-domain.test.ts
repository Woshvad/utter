// EIP-712 DebitAuthorization sign->recover suite (PAY-03; Pitfall 1 domain guard).
//
// Signs a DebitAuthorization with a known private key under the LOCKED escrow
// domain (UtterEscrow/1, chainId 5042002, verifyingContract = PAYMENT_ESCROW) and
// asserts recoverTypedDataAddress returns the buyer byte-for-byte. A reordered
// types array (control) must NOT recover to the buyer - proving the field order
// buyer,resourceId,maxAmount,nonce,validBefore matches the contract typehash.
// Offline unit test - no env, no RPC (signing + recovery are local).
import { describe, it, expect } from "vitest";
import {
  privateKeyToAccount,
  generatePrivateKey,
} from "viem/accounts";
import {
  createWalletClient,
  http,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { PAYMENT_ESCROW } from "@utter/chain";
import { signDebitAuthorization, DEBIT_AUTHORIZATION_TYPES } from "../src/client";

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
// A local wallet client; no transport call is made (signTypedData is offline).
const walletClient = createWalletClient({
  account,
  transport: http("http://localhost:0"),
});

const resourceId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const nonce =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

const msg = {
  buyer: account.address,
  resourceId,
  maxAmount: 10_000n,
  nonce,
  validBefore: 1_999_999_999n,
};

describe("eip712-domain DebitAuthorization sign + recover (PAY-03)", () => {
  it("recovers the signed authorization back to the buyer under the locked domain", async () => {
    const { authorization, signature } = await signDebitAuthorization(
      walletClient,
      msg,
    );

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "UtterEscrow",
        version: "1",
        chainId: 5042002,
        verifyingContract: PAYMENT_ESCROW,
      },
      types: { DebitAuthorization: DEBIT_AUTHORIZATION_TYPES },
      primaryType: "DebitAuthorization",
      message: authorization,
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("does NOT recover to the buyer when the field order is wrong (typehash mismatch)", async () => {
    const { authorization, signature } = await signDebitAuthorization(
      walletClient,
      msg,
    );

    // A reordered types array changes the struct hash -> recovery yields a
    // different address (the locked order is the only one that matches the
    // contract DEBIT_TYPEHASH).
    const reordered = [
      { name: "resourceId", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "maxAmount", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "validBefore", type: "uint256" },
    ] as const;

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "UtterEscrow",
        version: "1",
        chainId: 5042002,
        verifyingContract: PAYMENT_ESCROW,
      },
      types: { DebitAuthorization: reordered },
      primaryType: "DebitAuthorization",
      message: authorization,
      signature,
    });

    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});
