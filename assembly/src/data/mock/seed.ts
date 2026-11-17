/**
 * The demo snapshot, fetched the first time a demo load asks for it.
 *
 * It is a quarter of the whole program, and a board reading the live site
 * never opens it — so it is a file of its own, off the path every iPad
 * downloads before the board can draw. Only the data waits: the code that
 * reads it stays in the program, because a file fetched later that reached
 * back into the program would start a second copy of it.
 */

export type Seed = typeof import('./seed.json');

let loading: Promise<Seed> | null = null;

export function loadSeed(): Promise<Seed> {
  return (loading ??= import('./seed.json').then(
    (m) => m.default as Seed,
    (e) => {
      // A fetch that failed once is worth trying again on the next refresh.
      loading = null;
      throw e;
    },
  ));
}
