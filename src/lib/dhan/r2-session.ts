import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type R2State = {
  accessKeyId: string;
  secretAccessKey: string;
  setKeys: (accessKeyId: string, secretAccessKey: string) => void;
  clear: () => void;
};

export const useR2 = create<R2State>()(
  persist(
    (set) => ({
      accessKeyId: "",
      secretAccessKey: "",
      setKeys: (accessKeyId, secretAccessKey) => set({ accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }),
      clear: () => set({ accessKeyId: "", secretAccessKey: "" }),
    }),
    { name: "artha-r2", storage: createJSONStorage(() => localStorage) },
  ),
);
