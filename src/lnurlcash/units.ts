// The protocol layer speaks msat everywhere (LUD-25 amounts, kit fee math);
// humans think in sats. These helpers are the only place the two meet.

export const MSAT_PER_SAT = 1000

export const msatToSats = (msat: number): number => msat / MSAT_PER_SAT

export const satsToMsat = (sats: number): number => Math.round(sats * MSAT_PER_SAT)

// rounds up to the next whole sat - for an msat amount about to be
// requested as an invoice, where sub-sat precision (e.g. from a mint fee's
// percentage cut, see grossUpForMintFee) isn't reliably payable
export const ceilMsatToSat = (msat: number): number => Math.ceil(msat / MSAT_PER_SAT) * MSAT_PER_SAT

// rounds down to the nearest whole sat - for a fee-adjusted amount shown
// as an upper bound: rounding up there would advertise a note value that
// isn't actually reachable
export const floorMsatToSat = (msat: number): number =>
  Math.floor(msat / MSAT_PER_SAT) * MSAT_PER_SAT
