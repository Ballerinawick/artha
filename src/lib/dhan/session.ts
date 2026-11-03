import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type Session = {
  clientId: string;
  accessToken: string;
  tokenExp: number;
  setCreds: (clientId: string, accessToken: string) => void;
  clearToken: () => void;
  clear: () => void;
};

function tokenExpiry(token: string): number {
  const part = token.split(".")[1];
  if (part) {
    try {
      const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
      if (typeof json.exp === "number" && json.exp > 0) return json.exp * 1000;
    } catch {
      /* not a jwt */
    }
  }
  return Date.now() + 23 * 60 * 60 * 1000;
}

export const useDhanSession = create<Session>()(
  persist(
    (set) => ({
      clientId: "",
      accessToken: "",
      tokenExp: 0,
      setCreds: (clientId, accessToken) =>
        set({ clientId, accessToken, tokenExp: tokenExpiry(accessToken.trim()) }),
      clearToken: () => set({ accessToken: "", tokenExp: 0 }),
      clear: () => set({ clientId: "", accessToken: "", tokenExp: 0 }),
    }),
    {
      name: "artha-dhan",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function useDhanCreds() {
  const clientId = useDhanSession((s) => s.clientId);
  const accessToken = useDhanSession((s) => s.accessToken);
  const tokenExp = useDhanSession((s) => s.tokenExp);
  if (!clientId || !accessToken) return null;
  if (tokenExp > 0 && tokenExp <= Date.now()) return null;
  return { clientId, accessToken };
}
