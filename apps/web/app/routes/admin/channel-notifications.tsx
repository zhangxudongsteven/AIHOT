import { useState } from "react";
import { SITE } from "@aihot/site";
import type { AdminContentSubscriptionInput, AdminSpaceNotifyTarget, AdminSpaceSettings } from "@aihot/contracts/admin";
import type { Route } from "./+types/channel-notifications";
import { adminGet } from "../../lib/admin.server";
import { adminChannelApi } from "../../lib/admin-channel";
import { useAdminAction } from "../../features/admin/action";
import { useAdminDirty, useAdminSpace } from "../../features/admin/channel";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Empty, Field, ReasonDialog, Select } from "../../features/admin/ui";

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<AdminSpaceSettings>(request, adminChannelApi(params.spaceId!, "/settings"));
}
export const meta: Route.MetaFunction = () => [{ title: `飞书推送 · ${SITE.name} 后台` }];

function titleOf(target: AdminSpaceNotifyTarget) {
  if (target.targetName === "feishu-content-main") return "内容主群";
  if (target.targetName === "feishu-content-mirror") return "内容镜像群";
  return target.targetName ?? target.key;
}

function OperatorTarget({ target }: { target: AdminSpaceNotifyTarget }) {
  const { space, api } = useAdminSpace();
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return <Card title={titleOf(target)} right={<Badge tone={target.enabled ? "ok" : "muted"}>{target.enabled ? "目标已启用" : "目标已停用"}</Badge>}>
    <p className="text-[13px] text-ink-3">此目标由运维配置，尚未登记为可选群。原配置会保留；登记后可在这里调整群和订阅。</p>
    {target.enabled && <div className="mt-4 flex justify-end"><Button tone="danger" onClick={() => setOpen(true)}>停用</Button></div>}
    <ReasonDialog open={open} title={`停用 ${space.name} · ${titleOf(target)}`} confirmLabel="停用" danger busy={pending === "pause-target"} onClose={() => setOpen(false)} onSubmit={async reason => {
      if (target.targetName) return (await run("PUT", api("/content-subscription"), { targetName: target.targetName, groupId: null, enabled: false, subjectKinds: target.subject_kinds, reason }, { label: "pause-target", success: `${space.name} 目标已停用` })) !== null;
      return (await run("POST", `/api/admin/notify-targets/${encodeURIComponent(target.key)}`, { spaceId: space.id, enabled: false, reason }, { label: "pause-target", success: `${space.name} 目标已停用` })) !== null;
    }} />
  </Card>;
}

function TargetEditor({ target, groups }: { target: AdminSpaceNotifyTarget; groups: AdminSpaceSettings["pushGroups"] }) {
  const { space, api } = useAdminSpace();
  const { run, pending, busy } = useAdminAction();
  const [groupId, setGroupId] = useState(target.groupId ?? "");
  const [enabled, setEnabled] = useState(target.enabled);
  const [selected, setSelected] = useState(target.subject_kinds.includes("selected"));
  const [report, setReport] = useState(target.subject_kinds.includes("report"));
  const [baseline, setBaseline] = useState(() => JSON.stringify([target.groupId ?? "", target.enabled, target.subject_kinds.includes("selected"), target.subject_kinds.includes("report")]));
  const [open, setOpen] = useState(false);
  const subjectKinds: AdminContentSubscriptionInput["subjectKinds"] = [...(selected ? ["selected" as const] : []), ...(report ? ["report" as const] : [])];
  const signature = JSON.stringify([groupId, enabled, selected, report]);
  const changed = signature !== baseline;
  const { clear } = useAdminDirty(changed);
  const group = groups.find(g => g.id === groupId);
  const valid = Boolean(group && subjectKinds.length > 0 && (!enabled || group.configured));
  return <Card title={titleOf(target)} right={<Badge tone={target.enabled ? "ok" : "muted"}>{target.enabled ? "目标已启用" : "目标已停用"}</Badge>}>
    <div className="space-y-4">
      <Field label="飞书群" hint="使用已部署的群配置；需要更换实际群地址时由运维更新。">
        <Select aria-label={`${titleOf(target)}的飞书群`} disabled={busy} value={groupId} onChange={e => setGroupId(e.target.value)}>
          <option value="" disabled>请选择飞书群</option>
          {groups.map(g => <option key={g.id} value={g.id} disabled={!g.configured}>{g.label}{g.configured ? "" : "（未配置凭据）"}</option>)}
        </Select>
      </Field>
      {!group?.configured && <p className="text-[12.5px] text-amber">当前群的凭据尚未部署，不能开启推送。已有配置可以停用。</p>}
      <fieldset disabled={busy}>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">订阅内容</legend>
        <div className="flex flex-wrap gap-4 text-[13px] text-ink-2">
          <label className="inline-flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={selected} onChange={e => setSelected(e.target.checked)} />精选内容</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={report} onChange={e => setReport(e.target.checked)} />报告（日报、周报、月报）</label>
        </div>
      </fieldset>
      <label className="inline-flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={enabled} disabled={busy || (!group?.configured && !target.enabled)} onChange={e => setEnabled(e.target.checked)} />启用此目标</label>
      <p className="text-[12.5px] text-ink-3">订阅只作用于本频道后续符合条件的内容。启用或更换订阅不会补推历史内容。</p>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-[12px] text-ink-4">近 7 天投递 {num(target.deliveries_7d)} 次{target.enabled_at ? ` · 启用于 ${bj(target.enabled_at, true)}` : ""}</p>
        <Button tone="primary" disabled={!changed || !valid || busy} busy={pending === "content-subscription"} onClick={() => setOpen(true)}>保存推送配置</Button>
      </div>
    </div>
    <ReasonDialog open={open} title={`保存 ${space.name} · ${titleOf(target)}`} description={enabled ? "启用状态与订阅会保存；实际发送还受当前环境推送开关约束。" : "停用后，新的内容不再发往此目标。"} confirmLabel="保存" busy={pending === "content-subscription"} onClose={() => { if (!busy) setOpen(false); }} onSubmit={async reason => {
      const result = await run("PUT", api("/content-subscription"), { targetName: target.targetName!, groupId, enabled, subjectKinds, reason } satisfies AdminContentSubscriptionInput, { label: "content-subscription", success: `${space.name} 推送配置已保存` });
      if (result === null) return false;
      setBaseline(signature); clear(); return true;
    }} />
  </Card>;
}

export default function ChannelNotifications({ loaderData: settings }: Route.ComponentProps) {
  const targets = settings.targets.filter(t => t.purpose === "content" && t.kind === "feishu_webhook");
  return <AdminPage title={`${settings.space.name} · 飞书推送`} subtitle="各频道独立保存群目标、开关与订阅，即使发往同一个飞书群也分别管理。">
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-4 text-[13px] text-ink-3">
      <Badge tone={settings.gates.contentPushEnabled ? "ok" : "muted"}>{settings.gates.contentPushEnabled ? "当前环境推送已开启" : "当前环境推送已关闭"}</Badge>
      {!settings.gates.contentPushEnabled && <span>可以保存配置，当前环境不会向群发送消息。</span>}
      {!settings.space.enabled && <span>当前频道已停用。</span>}
    </div>
    {targets.length ? <div className="grid items-start gap-5 xl:grid-cols-2">{targets.map(t => t.targetName && (t.groupId !== null || t.config_ref === null)
      ? <TargetEditor key={`${settings.space.id}:${t.key}:${t.updated_at}`} target={t} groups={settings.pushGroups} />
      : <OperatorTarget key={`${settings.space.id}:${t.key}:${t.updated_at}`} target={t} />)}</div>
      : <Empty>本频道尚未配置飞书内容推送目标。</Empty>}
  </AdminPage>;
}
