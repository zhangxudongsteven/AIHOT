import { useState } from "react";
import { SITE } from "@aihot/site";
import type { AdminSpaceBudget, AdminSpaceSettings } from "@aihot/contracts/admin";
import type { Route } from "./+types/channel-quotas";
import { adminGet } from "../../lib/admin.server";
import { adminChannelApi } from "../../lib/admin-channel";
import { useAdminAction } from "../../features/admin/action";
import { useAdminDirty, useAdminSpace } from "../../features/admin/channel";
import { num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Field, Input, ReasonDialog } from "../../features/admin/ui";

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<AdminSpaceSettings>(request, adminChannelApi(params.spaceId!, "/settings"));
}
export const meta: Route.MetaFunction = () => [{ title: `模型请求额度 · ${SITE.name} 后台` }];

const fields = [
  ["perMinute", "每分钟", "per_minute"],
  ["perHour", "每小时", "per_hour"],
  ["perDay", "每天", "per_day"],
] as const;

function QuotaEditor({ budget, settings }: { budget: AdminSpaceBudget | undefined; settings: AdminSpaceSettings }) {
  const { space, api } = useAdminSpace();
  const { run, pending, busy } = useAdminAction();
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(([key, , column]) => [key, budget ? String(budget[column]) : ""])) as Record<(typeof fields)[number][0], string>);
  const [baseline, setBaseline] = useState(() => JSON.stringify(values));
  const [open, setOpen] = useState(false);
  const signature = JSON.stringify(values);
  const changed = signature !== baseline;
  const valid = fields.every(([key]) => values[key].trim() !== "" && Number.isInteger(Number(values[key])) && Number(values[key]) >= 0 && Number(values[key]) <= 2_147_483_647);
  const { clear } = useAdminDirty(changed);
  const reserved = [budget?.reserved_minute ?? 0, budget?.reserved_hour ?? 0, budget?.reserved_day ?? 0];
  const platform = settings.platformBudgets.find(b => b.service === "llm");
  return (
    <>
      <Card title="频道模型请求上限" right={<Badge tone={settings.gates.modelCallsEnabled ? "ok" : "muted"}>{settings.gates.modelCallsEnabled ? "模型调用已开启" : "模型调用已关闭"}</Badge>}>
        {!settings.gates.modelCallsEnabled && <p className="mb-4 text-[13px] text-ink-3">当前环境模型调用已关闭，保存额度不会启动调用。</p>}
        {!budget && <p className="mb-4 text-[13px] text-ink-3">未单独设置频道额度，当前仅受平台总上限约束。填写三个上限后可建立频道额度。</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          {fields.map(([key, label]) => (
            <Field key={key} label={label}>
              <Input aria-label={label} type="number" min={0} max={2_147_483_647} step={1} disabled={busy} value={values[key]} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />
            </Field>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">按实际请求次数计量，失败、重试及模型回退也计入；每天指滚动 24 小时。任一上限为 0 时暂停该频道模型请求。</p>
        {reserved.some(n => n > 0) && <p className="mt-2 text-[12.5px] text-ink-3">预留容量（分钟 / 小时 / 天）：{reserved.join(" / ")}。调整上限时保留现有预留容量。</p>}
        <div className="mt-5 flex justify-end">
          <Button tone="primary" disabled={!changed || !valid || busy} busy={pending === "channel-budget"} onClick={() => setOpen(true)}>保存额度</Button>
        </div>
        <ReasonDialog open={open} title={`调整 ${space.name} 的模型请求额度`} description="仅修改当前频道的请求上限，平台总上限仍同时生效。" confirmLabel="保存" busy={pending === "channel-budget"} onClose={() => { if (!busy) setOpen(false); }} onSubmit={async reason => {
          const result = await run("PUT", api("/budgets/llm"), {
          perMinute: Number(values.perMinute), perHour: Number(values.perHour), perDay: Number(values.perDay),
          reason,
          }, { label: "channel-budget", success: `${space.name} 模型额度已保存` });
          if (result === null) return false;
          setBaseline(signature); clear(); return true;
        }} />
      </Card>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="当前频道已用请求">
          <p className="num text-[20px] text-ink">{budget ? `${num(budget.used_minute)} / ${num(budget.used_hour)} / ${num(budget.used_day)}` : "—"}</p>
          <p className="mt-2 text-[12.5px] text-ink-3">近 1 分钟 / 近 1 小时 / 近 24 小时</p>
        </Card>
        <Card title="平台模型总上限">
          <p className="num text-[20px] text-ink">{platform ? `${num(platform.per_minute)} / ${num(platform.per_hour)} / ${num(platform.per_day)}` : "未设置平台总上限"}</p>
          <p className="mt-2 text-[12.5px] text-ink-3">每分钟 / 每小时 / 每天，AI 与网络安全共同受此上限约束。修改请到平台设置。</p>
        </Card>
      </div>
    </>
  );
}

export default function ChannelQuotas({ loaderData: settings }: Route.ComponentProps) {
  const budget = settings.budgets.find(b => b.service === "llm");
  return <AdminPage title={`${settings.space.name} · 模型请求额度`} subtitle="每个频道独立设置上限并统计实际请求。修改记录写入审计。">
    <QuotaEditor key={`${settings.space.id}:${budget?.updated_at ?? "unset"}`} budget={budget} settings={settings} />
  </AdminPage>;
}
