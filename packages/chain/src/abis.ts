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

// StakingVault ABI - the Phase 5 staking + takedown surface (STK-01, STK-02,
// STK-03). Field names and order are copied verbatim from contracts/src/
// StakingVault.sol so the Slashed/Refunded events decode byte-for-byte and the
// deposit/slash/refund arguments line up with the contract signature. All
// amounts are USDC base units; this ABI never encodes a decimals literal (the
// vault denominates bonds in raw base units, never a 6/1e6 scaling; Pitfall 3).
export const stakingVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resourceId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "slash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resourceId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "requestWithdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "bonds",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "insurancePoolBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_BOND_BASE_UNITS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "COOLDOWN",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Slashed",
    inputs: [
      { name: "resourceId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "payer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// ResourceRegistry ABI - the Phase 5 registry write/read surface (MKT-01, STK-03).
// Field names and order are copied verbatim from contracts/src/ResourceRegistry.sol
// so register/update/pause/unpause/slashAuthorization encode byte-for-byte and the
// ResourcePaused/ResourceSlashAuthorized events decode for the indexer. getResource
// and isActive are the reads the escrow active-check and marketplace listing perform.
// All amounts are USDC base units; this ABI never encodes a decimals literal (Pitfall 3).
export const registryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resourceId", type: "bytes32" },
      { name: "creator", type: "address" },
      { name: "treasury", type: "address" },
      { name: "creatorBps", type: "uint16" },
      { name: "agentId", type: "bytes32" },
      { name: "pricingHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "update",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resourceId", type: "bytes32" },
      { name: "treasury", type: "address" },
      { name: "creatorBps", type: "uint16" },
      { name: "agentId", type: "bytes32" },
      { name: "pricingHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "unpause",
    stateMutability: "nonpayable",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "slashAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resourceId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getResource",
    stateMutability: "view",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "treasury", type: "address" },
      { name: "creatorBps", type: "uint16" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{ name: "resourceId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "ResourcePaused",
    inputs: [{ name: "resourceId", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ResourceSlashAuthorized",
    inputs: [
      { name: "resourceId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

// Phase 5 ERC-8004 reference ABI - Plan 02 fills this after the reference
// contracts are authored and CREATE2-deployed. Empty placeholder for now so the
// barrel export and downstream typing seam exist from Wave 0. These ABIs will
// encode amounts only as uint256 base units, never a 6/1e6 literal (Pitfall 3).
export const identityAbi = [] as const;

// Phase 5 ERC-8004 reference ABI - Plan 02 fills this after the reference
// contracts are authored and CREATE2-deployed.
export const reputationAbi = [] as const;

// Phase 5 ERC-8004 reference ABI - Plan 02 fills this after the reference
// contracts are authored and CREATE2-deployed.
export const validationAbi = [] as const;
