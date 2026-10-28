import { motion } from "motion/react";
import { Suspense } from "react";
import { SITE } from "@aihot/site";
import { Await, data, NavLink, Outlet, useLocation, useNavigate, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/layout";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { NavigationProgress } from "../../components/shell/Chrome";
import type { AdminMe, AdminNavCounts, AdminSpace, AdminSpaces } from "@aihot/contracts/admin";
import { Toaster } from "../../features/admin/toast";
import { adminGet } from "../../lib/admin.server";
import type { AdminNavEntry } from "../../modules";
import { webModules } from "../../site-modules";
import { adminChannelPath, adminSpaceId } from "../../lib/admin-channel";
import { AdminDirtyProvider } from "../../features/admin/channel";

export async function loader({ request }: Route.LoaderArgs) {
  const counts = adminGet<AdminNavCounts>(request, "/api/admin/nav-counts").catch((): AdminNavCounts => ({}));
  const [me, { spaces }] = await Promise.all([
    adminGet<AdminMe>(request, "/api/admin/me"), adminGet<AdminSpaces>(request, "/api/admin/spaces"),
  ]);
  let spaceId: string | null;
  try { spaceId = adminSpaceId(new URL(request.url).pathname); }
  catch { throw data({ message: "not_found" }, { status: 404 }); }
  if (spaceId !== null && !spaces.some((space) => space.id === spaceId)) throw data({ message: "not_found" }, { status: 404 });
  // Reset the badge boundaries so a navigation transition never keeps the old page waiting on them.
  return { me, counts, spaces, countsKey: crypto.randomUUID() };
}

// Verify identity and update badges on every navigation/command; badges do not hold up the page.
export const shouldRevalidate: ShouldRevalidateFunction = () => true;

export const meta: Route.MetaFunction = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Accel-Buffering": "no" });

type Entry = AdminNavEntry & { countValue?: number };
const nav = (space: AdminSpace | undefined): Array<{ group: string; items: Entry[] }> => [
  ...(space ? [{ group: `${space.name} · 频道管理`, items: [
    { to: adminChannelPath(space.id, "/sources"), label: "信源", countValue: space.failedSources, tone: "bad" as const },
    { to: adminChannelPath(space.id, "/quotas"), label: "模型请求额度" },
    { to: adminChannelPath(space.id, "/notifications"), label: "飞书推送" },
  ] }] : []),
  ...webModules().flatMap((m) => (m.admin?.groups ?? []).map((group) => ({ ...group, group: `${group.group} · 全站` }))),
  {
    group: "全站运营",
    items: [
      { to: "/admin/content", label: "内容诊断" },
      ...webModules().flatMap((m) => m.admin?.content ?? []),
      { to: "/admin/feedback", label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "平台系统",
    items: [
      { to: "/admin/runs", label: "运行", count: "runs", tone: "bad" },
      { to: "/admin/models", label: "AI 模型与全站统计" },
      { to: "/admin/selectbench", label: "AI SelectBench" },
      { to: "/admin/settings", label: "平台设置" },
      { to: "/admin/audit", label: "审计记录" },
    ],
  },
];

type Counts = Pick<Route.ComponentProps["loaderData"], "counts" | "countsKey">;

function NavCount({ counts, countsKey, name, className, value }: Counts & { name: string | undefined; className: string; value?: number }) {
  if (value !== undefined) return value > 0 ? <span className={className}>{value}</span> : null;
  if (!name) return null;
  return (
    <Suspense key={countsKey} fallback={null}>
      <Await resolve={counts} errorElement={null}>
        {(resolved: AdminNavCounts) => resolved[name] ? <span className={className}>{resolved[name]}</span> : null}
      </Await>
    </Suspense>
  );
}

function NavItem({ to, label, count, counts, countsKey, tone, countValue }: Entry & Counts) {
  return (
    <NavLink to={to} className="group relative block">
      {({ isActive }) => (
        <span className={`relative flex items-center justify-between rounded-control px-3 py-[7px] text-[13.5px] transition-colors ${isActive ? "font-medium text-ink" : "text-ink-3 hover:text-ink"}`}>
          {isActive && <motion.span layoutId="admin-nav" className="absolute inset-0 rounded-control bg-surface shadow-sm ring-1 ring-line" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
          <span className="relative">{label}</span>
          <NavCount counts={counts} countsKey={countsKey} name={count} value={countValue} className={`num relative min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${tone === "bad" ? "bg-hot text-white" : "bg-accent-soft text-accent"}`} />
        </span>
      )}
    </NavLink>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return <AdminDirtyProvider><AdminShell loaderData={loaderData} /></AdminDirtyProvider>;
}

function AdminShell({ loaderData }: Pick<Route.ComponentProps, "loaderData">) {
  const { me, counts, countsKey, spaces } = loaderData;
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const spaceId = adminSpaceId(location.pathname);
  const space = spaces.find((entry) => entry.id === spaceId);
  const groups = nav(space);
  const flat = groups.flatMap((g) => g.items);
  const scope = space ? `${space.name} · 频道管理${space.enabled ? "" : "（已停用，可调整配置）"}`
    : location.pathname.startsWith("/admin/selectbench") ? "AI 默认频道 · SelectBench"
    : location.pathname === "/admin/models" ? "平台 · AI 默认模型配置 / 全站调用统计" : "平台 · 全站范围";
  const selector = <label className="flex flex-col gap-1 text-[11px] text-ink-4">
    管理范围
    <select aria-label="管理范围" value={spaceId ?? ""} className="min-h-9 rounded-control border border-line bg-surface px-2 text-[13px] font-medium text-ink" onChange={(event) => {
      const id = event.target.value;
      if (!id) { void navigate("/admin/settings"); return; }
      if (!spaces.some((entry) => entry.id === id)) return;
      const section = /\/quotas$/.test(location.pathname) ? "/quotas" : /\/notifications$/.test(location.pathname) ? "/notifications" : "/sources";
      void navigate(adminChannelPath(id, section));
    }}>
      <option value="">平台（全站）</option>
      {spaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.enabled ? "" : "（已停用）"}</option>)}
    </select>
  </label>;
  return (
    <div className="flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-bg-sunk/50 px-3 py-4 lg:flex">
        <a href="/" className="mb-5 flex items-center gap-2 px-2">
          <RingMark className="size-6 text-accent" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">{`${SITE.name} 后台`}</span>
        </a>
        <div className="mb-4 px-2">{selector}</div>
        <nav className="scrollbar-thin flex-1 space-y-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map((i) => (
                  <NavItem key={i.to} {...i} counts={counts} countsKey={countsKey} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px] text-ink-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{me.name}</span>
            {me.dev && <span className="rounded-mark bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <form method="post" action="/api/auth/logout" className="mt-1.5">
            <button type="submit" className="text-ink-4 hover:text-ink-2">退出登录</button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 px-4 pt-3">
            <RingMark className="size-5 text-accent" />
            <span className="text-[14px] font-semibold text-ink">{`${SITE.name} 后台`}</span>
            {me.dev && <span className="rounded-mark bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <div className="px-4 pt-2">{selector}</div>
          <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
            {flat.map((i) => {
              const active = location.pathname === i.to || location.pathname.startsWith(`${i.to}/`);
              return (
                <NavLink key={i.to} to={i.to} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[13px] ${active ? "bg-ink text-bg" : "text-ink-3"}`}>
                  {i.label}
                  <NavCount counts={counts} countsKey={countsKey} name={i.count} value={i.countValue} className="num ml-1 text-[11px] opacity-70" />
                </NavLink>
              );
            })}
          </nav>
        </div>
        <main className="min-w-0 flex-1">
          <div className="border-b border-line bg-bg-sunk/50 px-5 py-2 text-[12px] text-ink-3">{scope}</div>
          <Outlet key={location.pathname} />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
