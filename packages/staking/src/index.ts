// @utter/staking - the StakingVault bond + takedown client (STK-01/02/03). It
// reads/writes the deployed StakingVault (bond deposit, slash into the insurance
// pool, refund, cooldown withdraw) and the ResourceRegistry pause/slashAuthorization
// using stakingVaultAbi + registryAbi from @utter/chain. All amounts are USDC base
// units read via decimals(), never a 6/1e6 literal.
//
// This is the Wave 0 barrel: the feature waves append the bond + takedown client.
// Nothing is exported yet.
export {};
