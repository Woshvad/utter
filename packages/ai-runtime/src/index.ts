// @utter/ai-runtime - the prompt-to-bundle generation member (SPEC §9.2).
//
// Public barrel. Task 3 of plan 04-01 wires the type + generator contracts
// through here (ResourceSpec, BUNDLE_KEYS, the re-exported Bundle, the Generator
// interface, and selectGenerator). Later plans (04-02 backends, 04-03 validator)
// add the generate()/validateBundle() functions. Kept minimal in Wave 0 so the
// member registers and type-checks before the contracts land.
export {};
