// Whether Data saver is on right now, outside React. lib/data-saver.tsx keeps it in sync;
// the API client (lib/api.ts) and uploads (lib/media.ts) read it. No imports, so no require cycles.
let active = false;

export const setDataSaverActive = (on: boolean) => void (active = on);
export const isDataSaverActive = () => active;
/** Sent with every API request: on Data saver, responses leave out large photo sizes. */
export const dataSaverHeaders = (): Record<string, string> => (active ? { 'save-data': 'on' } : {});
