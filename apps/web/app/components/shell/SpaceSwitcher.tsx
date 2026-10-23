import { useLocation, useNavigate, useRouteLoaderData } from "react-router";
import type { SiteMeta } from "@aihot/contracts/site";
import { spacePath, spaceSlug } from "../../lib/space-path";

/** A switch always opens the destination home; detail identifiers never carry across channels. */
export function SpaceSwitcher({ compact = false }: { compact?: boolean }) {
  const meta = useRouteLoaderData("root") as SiteMeta | undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const spaces = meta?.spaces ?? [];
  if (spaces.length < 2) return null;
  const selected = spaceSlug(location.pathname) ?? spaces.find(s => s.id === "default")?.slug ?? "default";
  return <label className={`flex min-w-0 items-center gap-2 text-ink-3 ${compact ? "py-1.5 text-[12px]" : "mb-2 flex-col items-stretch px-2 text-[11px]"}`}>
    <span>频道</span>
    <select aria-label="切换频道" value={selected} onChange={event => {
      const target = spaces.find(s => s.slug === event.target.value);
      if (target) void navigate(target.id === "default" ? "/" : spacePath("/", target.slug));
    }} className="min-h-9 min-w-0 rounded-control border border-line bg-surface px-2 text-[13px] font-medium text-ink focus-visible:outline-accent">
      {spaces.map(space => <option key={space.id} value={space.slug}>{space.name}</option>)}
    </select>
  </label>;
}
