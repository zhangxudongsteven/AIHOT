import { useSpace } from "../../lib/space";
import { Address, Block } from "./parts";
import { CodeBlock } from "./CodeBlock";
import { ReadingLayout } from "../../components/ui/Page";
import { PhoneBar } from "../../components/shell/PhoneBar";
export function SpaceGuide({ base, healthy }: { base: string; healthy: boolean }) {
  const { path, space, categories } = useSpace();
  const url = (value: string) => base + path(value);
  return <><PhoneBar title="Agent 接入" large /><ReadingLayout>
    <header className="mb-7"><h1 className="hidden text-[26px] font-semibold lg:block">Agent 接入</h1>
      <p className="mt-3 text-[14px] text-ink-3">当前频道：{space?.name}。这些地址只返回当前频道公开的内容。</p>
      <p className="mt-2 text-[12px] text-ink-4">{healthy ? "服务正常" : "服务暂不可用"} · 匿名只读 · 无需 Key</p>
    </header>
    <Block title="MCP"><Address url={url("/api/mcp")} /><CodeBlock lang="bash" code={`codex mcp add channel --url '${url("/api/mcp")}'`} /></Block>
    <Block title="RSS"><div className="space-y-4">{[["精选摘要", "/feed.xml"], ["精选全文", "/feed/full.xml"], ["全部动态", "/feed/all.xml"], ["日报", "/feed/daily.xml"], ["周报", "/feed/weekly.xml"], ["月报", "/feed/monthly.xml"]].map(([label, endpoint]) => <div key={endpoint}><h3 className="mb-1 text-[13px] font-medium">{label}</h3><Address url={url(endpoint!)} /></div>)}</div></Block>
    <Block title="公开 API"><Address url={url("/api/v1/items")} /><CodeBlock lang="bash" code={`curl '${url("/api/v1/items")}?limit=10'`} /><p className="mt-3 text-[13px] text-ink-3">分类：{categories.map(category => `${category.label} (${category.key})`).join("、")}</p></Block>
    <Block title="频道报告"><p className="mb-3 text-[13px] text-ink-3">日报、周报和月报各自归档；MCP 可读取本频道报告，Markdown 适合直接给 Agent 阅读。</p><Address url={url("/api/v1/dailies")} /><Address url={url("/api/v1/agent/daily")} /></Block>
    <Block title="接口说明"><div className="space-y-3">{[["Agent 使用说明", "/api/v1/agent"], ["OpenAPI", "/openapi-v1.json"], ["llms.txt", "/llms.txt"]].map(([label, endpoint]) => <div key={endpoint}><a className="text-[14px] text-accent hover:underline" href={url(endpoint!)}>{label}</a></div>)}</div></Block>
  </ReadingLayout></>;
}
