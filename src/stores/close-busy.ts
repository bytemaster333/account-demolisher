// raised by the demolish page while its machine is executing a close. the app
// shell reads it to ask before in-app navigation and to hold the wallet and
// network controls: leaving the page unmounts the run and a wallet or network
// change cancels it, and either way the close stops at its next step with the
// account part way closed.

import { create } from "zustand";

interface CloseBusyState {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

export const useCloseBusy = create<CloseBusyState>((set) => ({
  busy: false,
  setBusy: (busy) => set({ busy }),
}));
