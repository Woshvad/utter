// Minimal ERC-20 ABI - the four view functions Phase 0 needs (CHAIN-02).
// `decimals` is the load-bearing entry: it is read at runtime on every USDC
// amount path so no consumer hardcodes 6 or 18 (the decimals trap; SPEC §6).
export const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// PaymentEscrow write-path ABI - the Phase 2 facilitator settle surface (PAY-09,
// PAY-11). Field names and order are copied verbatim from contracts/src/
// PaymentEscrow.sol so the Debited event decodes byte-for-byte and the debit
// arguments line up with the contract signature. The DebitAuthorization fields
// the buyer signs (buyer, resourceId, maxAmount, nonce, validBefore) are the
// LOCKED EIP-712 order - do not reorder. All amounts are USDC base units; this
// ABI never encodes a decimals literal.
export const escrowAbi = [
  {
    type: "function",
    name: "debit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "buyer", type: "address" },
      { name: "resourceId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "maxAmount", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "validBefore", type: "uint256" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "usedNonce",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Debited",
    inputs: [
      { name: "resourceId", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "toCreator", type: "uint256", indexed: false },
      { name: "toTreasury", type: "uint256", indexed: false },
      { name: "nonce", type: "bytes32", indexed: false },
    ],
  },
] as const;

// PaymentSplitter ABI - the flat (`exact`) path flushes the held USDC split via
// distribute() (PAY-08). Phase 1 contract already implements the inline split.
export const splitterAbi = [
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

// ERC-3009 ABI - Arc USDC implements transferWithAuthorization for the flat
// `exact` settlement scheme (PAY-08). Field order matches the canonical EIP-3009
// typed data (from, to, value, validAfter, validBefore, nonce) plus the split v/r/s
// the relayer submits; authorizationState is the on-chain replay guard. decimals is
// re-declared here as a view so the `exact` amount path can read it at runtime via
// this ABI without importing erc20Abi - never a hardcoded 6.
export const erc3009Abi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;
