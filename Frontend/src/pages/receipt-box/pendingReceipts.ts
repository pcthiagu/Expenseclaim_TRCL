/** Hand-off from the Receipt box ("Create expense claim") to the new claim form: the ids of the bills picked. In memory only. */
let ids: string[] = [];
export const setPendingReceipts = (list: string[]): void => { ids = [...list]; };
/** Reads without clearing (safe under React StrictMode's double initialisation). */
export const peekPendingReceipts = (): string[] => [...ids];
export const clearPendingReceipts = (): void => { ids = []; };
