// raised by the demolish page while its machine is executing a close. the app
// shell reads it to hold navigation and the wallet and network controls, because
// leaving the page or switching wallets mid-run does not stop the signing.

import { create } from "zustand";

interface CloseBusyState {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

export const useCloseBusy = create<CloseBusyState>((set) => ({
  busy: false,
  setBusy: (busy) => set({ busy }),
}));
