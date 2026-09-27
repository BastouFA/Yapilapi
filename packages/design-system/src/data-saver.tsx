import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether Data saver is on for this screen. Apps work it out (the account's
 * setting, this device's choice and the connection) and provide it once at the
 * root; media components read it to load small sizes and not autoplay.
 */
const DataSaverContext = createContext(false);

export function DataSaverProvider({ on, children }: { on: boolean; children: ReactNode }) {
  return <DataSaverContext.Provider value={on}>{children}</DataSaverContext.Provider>;
}

export function useDataSaver(): boolean {
  return useContext(DataSaverContext);
}
