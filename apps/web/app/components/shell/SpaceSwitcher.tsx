import { useLocation, useNavigate, useRouteLoaderData } from "react-router";
import type { SiteMeta } from "@aihot/contracts/site";
import { spacePath, spaceSlug } from "../../lib/space-path";
import { Select } from "../ui/Controls";

/** A switch always opens the destination home; detail identifiers never carry across channels. */
export function SpaceSwitcher({ compact = false }: { compact?: boolean }) {
  const meta = useRouteLoaderData("root") as SiteMeta | undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const spaces = meta?.spaces ?? [];
  if (spaces.length < 2) return null;
  const selected = spaceSlug(location.pathname) ?? spaces.find(s => s.id === "default")?.slug ?? "default";
  return (
    <label className={`flex min-w-0 gap-2 ${compact ? "items-center py-2" : "mb-2 flex-col px-2"}`}>
      <span className="shrink-0 text-[11px] text-ink-4">频道</span>
      <Select aria-label="切换频道" value={selected} className={compact ? "min-w-0 max-w-full" : "w-full min-w-0"} onChange={event => {
        const target = spaces.find(s => s.slug === event.target.value);
        if (target) void navigate(target.id === "default" ? "/" : spacePath("/", target.slug));
      }}>
        {spaces.map(space => <option key={space.id} value={space.slug}>{space.name}</option>)}
      </Select>
    </label>
  );
}
