import { createContext } from 'react';

/** The browser pane owned by the currently open conversation, if any. */
export type BrowserPaneAccess = {
  conversationId: string;
  open(): void;
};

/** A handoff card uses the conversation's single pane instead of opening a second live stream. */
export const BrowserPaneContext = createContext<BrowserPaneAccess | null>(null);
