// EIP-3009 TransferWithAuthorization sign->recover suite (PAY-08).
//
// Signs an `exact` TransferWithAuthorization under the CONFIRMED Arc USDC domain
// (USDC/2, chainId 5042002, verifyingContract = USDC) and asserts recovery
// returns `from` byte-for-byte. The `exact` path is FLAT-only (no gate, no
// metering). Offline unit test - signing + recovery are local.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createWalletClient,
  http,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { USDC, PAYMENT_SPLITTER } from "@utter/chain";
import { signExactTransfer, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/client";

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const walletClient = createWalletClient({
  account,
  transport: http("http://localhost:0"),
});

const nonce =
  "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;

const msg = {
  from: account.address,
  to: PAYMENT_SPLITTER,
  value: 8_000n,
  validAfter: 0n,
  validBefore: 1_999_999_999n,
  nonce,
};

describe("erc3009-domain exact TransferWithAuthorization sign + recover (PAY-08)", () => {
  it("recovers the signed transfer back to `from` under the Arc USDC domain", async () => {
    const { authorization, signature } = await signExactTransfer(walletClient, msg);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 5042002,
        verifyingContract: USDC,
      },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
      primaryType: "TransferWithAuthorization",
      message: authorization,
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
