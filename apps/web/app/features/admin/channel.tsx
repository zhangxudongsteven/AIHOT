import { createContext, useCallback, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { useBeforeUnload, useBlocker, useLocation, useRouteLoaderData } from "react-router";
import type { AdminSpace } from "@aihot/contracts/admin";
import { Sheet } from "../../components/ui/Sheet";
import { adminChannelApi, adminChannelPath, adminSpaceId } from "../../lib/admin-channel";
import { Button } from "./ui";

export function useAdminSpaces(): AdminSpace[] {
  return (useRouteLoaderData("admin-layout") as { spaces: AdminSpace[] }).spaces;
}

export function useAdminSpace() {
  const spaceId = adminSpaceId(useLocation().pathname);
  const space = useAdminSpaces().find((entry) => entry.id === spaceId);
  if (!space) throw new Error("This page requires a valid management channel");
  return {
    space, spaceId: space.id,
    path: (suffix: string) => adminChannelPath(space.id, suffix),
    api: (suffix: string) => adminChannelApi(space.id, suffix),
  };
}

const DirtyContext = createContext<((id: string, dirty: boolean) => void) | null>(null);

export function AdminDirtyProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const update = useCallback((id: string, changed: boolean) => {
    if (changed) dirty.current.add(id);
    else dirty.current.delete(id);
  }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty.current.size > 0
    && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  useBeforeUnload(useCallback((event) => {
    if (!dirty.current.size) return;
    event.preventDefault();
    event.returnValue = "";
  }, []));
  const stay = () => { if (blocker.state === "blocked") blocker.reset(); };
  return <DirtyContext.Provider value={update}>
    {children}
    <Sheet open={blocker.state === "blocked"} onClose={stay} title="放弃未保存的修改？" centered>
      <div className="px-5 pb-2">
        <p className="text-[13px] leading-relaxed text-ink-3">离开后，当前页面未保存的修改将被放弃。</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button tone="ghost" onClick={stay}>继续编辑</Button>
          <Button tone="danger" onClick={() => {
            dirty.current.clear();
            if (blocker.state === "blocked") blocker.proceed();
          }}>放弃修改并离开</Button>
        </div>
      </div>
    </Sheet>
  </DirtyContext.Provider>;
}

export function useAdminDirty(dirty: boolean) {
  const update = useContext(DirtyContext);
  const id = useId();
  useEffect(() => {
    update?.(id, dirty);
    return () => update?.(id, false);
  }, [update, id, dirty]);
  return { clear: useCallback(() => update?.(id, false), [update, id]) };
}
