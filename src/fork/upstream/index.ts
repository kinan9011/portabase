/**
 * Copy-and-own adapter to upstream Portabase (D31). The ONLY place in `src/fork/**` that imports upstream tables/modules for the
 * materializer; `__tests__/unit/w10-static.test.ts` enforces the boundary and `w10-upstream-contract.test.ts` pins every
 * assumption (run on every W-SYNC). Nothing here reads a session or calls a `userAction`.
 */
export * from "./agents";
export * from "./channels";
export * from "./credentials";
export * from "./master-key";
export * from "./projects";
export * from "./sources";
