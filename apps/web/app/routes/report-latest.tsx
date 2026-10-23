import { nonDefaultSpace, withSpaceMeta } from "../lib/seo";
import { useSpace } from "../lib/space";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import { REPORT_NAMES, type ReportLatestPage } from "@aihot/contracts/site";
import { REPORTS, subjectAfter, withSubject } from "@aihot/site";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta, reportLd } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "日报" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const { index, report } = await loadOr404<ReportLatestPage>(`/api/site/reports/${kind}/latest-page`, { request, signal: request.signal });
  return cachedPage(600, { kind, report, index, today: beijingDate(Date.now()) });
}

function routeMeta(args: Route.MetaArgs) {
  const { loaderData, location } = args;
  const space = nonDefaultSpace(args);
  const kind = loaderData?.kind ?? "daily";
  const description = space ? `${space.name}的${REPORT_NAMES[kind]}，按频道规则汇集公开动态，附原文来源。` : `${REPORTS.descriptions[kind]}。`;
  const report = loaderData?.report;
  return [...pageMeta({
    title: space ? `${space.name} ${REPORT_NAMES[kind]}` : withSubject(REPORT_NAMES[kind]),
    description,
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
    // The latest issue, described at this page's own address (its canonical).
    jsonLd: report ? reportLd(report, location.pathname, report.lead?.leadParagraph ?? description) : undefined,
  }), feedLink(kind)];
}

export default function ReportLatestPage() {
  const { isDefault } = useSpace();
  const { kind, report, index, today } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today} outline={report ? reportOutline(report) : []}>
      {report ? <ReportPaper report={report} index={index} /> : <EmptyState title={isDefault ? subjectAfter("还没有发布", REPORT_NAMES[kind]) : `还没有发布${REPORT_NAMES[kind]}`}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}

export const meta = withSpaceMeta(routeMeta);
