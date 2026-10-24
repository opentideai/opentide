// Test fixture (Feature B / B1b): a stand-in child that exits non-zero BEFORE
// emitting any ready line — the AddrInUse / early-failure case. Drives the
// supervisor's exit-before-ready retry path. NOT production code.

console.error("fake child: simulated early failure");
Deno.exit(3);
