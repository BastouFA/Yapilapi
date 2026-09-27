/** The next seat after `from` that is still playing (skips seats that forfeited). */
export function nextSeat(seats: number, out: readonly number[], from: number): number {
  for (let i = 1; i <= seats; i++) {
    const s = (from + i) % seats;
    if (!out.includes(s)) return s;
  }
  return from;
}

/** Seats still playing. */
export function activeSeats(seats: number, out: readonly number[]): number[] {
  return Array.from({ length: seats }, (_, i) => i).filter((s) => !out.includes(s));
}
