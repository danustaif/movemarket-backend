// Salinan enum Outcome dari source/sot/constants.json (nilai = indeks uint8 di kontrak).
// Tidak mengimpor @movemarket/shared karena Envio Cloud hanya meng-clone repo backend.
// test/sot.test.ts memastikan salinan ini sama dengan SOT.
export const Outcome = { NONE: 0, YES: 1, NO: 2, VOID: 3 } as const;
