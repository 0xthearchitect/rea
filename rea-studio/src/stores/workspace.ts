import { create } from "zustand";
import { persist } from "zustand/middleware";
export type View =
  | "findings"
  | "graph"
  | "source"
  | "evidence"
  | "connection"
  | "agent";
interface Workspace {
  project: string;
  job: string;
  selected: string;
  view: View;
  theme: "dark" | "light";
  left: number;
  right: number;
  bottom: number;
  inspector: boolean;
  console: boolean;
  set: (value: Partial<Omit<Workspace, "set">>) => void;
}
export const useWorkspace = create<Workspace>()(
  persist(
    (set) => ({
      project: "",
      job: "",
      selected: "",
      view: "findings",
      theme: "dark",
      left: 245,
      right: 310,
      bottom: 205,
      inspector: true,
      console: true,
      set: (value) => set(value),
    }),
    { name: "rea-studio-layout-v1" },
  ),
);
