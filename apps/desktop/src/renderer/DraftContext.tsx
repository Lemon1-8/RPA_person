import { createContext } from 'react';
export const DraftContext = createContext<{ texts: Record<string, string>; scope: string; write(key: string, value?: string): void }>({ texts: {}, scope: '', write: () => {} });
