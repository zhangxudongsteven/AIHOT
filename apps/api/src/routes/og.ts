// Share images (1200×630 PNG) for pages, items, reports, topics and events. Only public content
// gets a card; anything else is a real 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { reportDateLabel } from "@aihot/contracts/site";
import { publicationCategoryLabel } from "@aihot/backend/publication/taxonomy";
import { publicationCacheKey, publicationPath, publicationSpace, publicationSpaceId } from "@aihot/backend/publication/context";
import { createHash } from "node:crypto";
import { beijingDate } from "@aihot/contracts/time";
import { loadItemOgCard, loadItemShare } from "@aihot/backend/publication/og";
import { loadReport, reportEditionWhen, type ReportKind } from "@aihot/backend/publication/reports";
import { findTopic, publicationTopicGroups, publicationTopics } from "@aihot/backend/publication/topics";
import { loadStoryDetail, resolveStory } from "@aihot/backend/publication/stories";
import { ogEtag, renderOg, type OgCard } from "@aihot/backend/media/og";
import { posterEtag, renderPoster, type Poster } from "@aihot/backend/media/poster";
import { CARDS, ITEM_COPY, REPORTS, withSubject } from "@aihot/site";
import { config } from "@aihot/backend/config";

/** The pages' share cards: the site's texts, and the topic count of the topic list. */
const pages = (): Record<string, OgCard> => {
  const cards: Record<string, OgCard> = {
    ...CARDS,
    topics: { kicker: "主题", title: `${publicationTopics().length} 个长期追踪方向`, subtitle: `${publicationTopicGroups().map(g => g.name).join("、")}。` },
  };
  if (publicationSpaceId() !== "default") {
    cards.site = { kicker: "频道精选", title: publicationSpace()!.name, subtitle: "关注频道内的精选、最新动态与热点事件。" };
    cards.about = { kicker: "关于频道", title: publicationSpace()!.name, subtitle: "频道信源与公开内容概览。" };
    cards.all = { ...cards.all!, kicker: "全部动态" };
    for (const [name, label] of Object.entries({ daily: "日报", weekly: "周报", monthly: "月报" })) cards[name] = {
      kicker: label, title: `${publicationSpace()!.name} ${label}`, subtitle: `${reportEditionWhen()[name as ReportKind]}出刊，汇集本频道动态。`,
    };
  }
  return cards;
};

/**
 * Article, event and report images carry editable content. A reader may keep a copy for five
 * minutes; shared caches are refreshed on publication changes. Brand images keep their own lifetime.
 */
const CONTENT_IMAGE_CACHE = "public, max-age=300, s-maxage=3600, must-revalidate";

async function send(req: FastifyRequest, reply: FastifyReply, card: OgCard, maxAge: number, cacheControl = `public, max-age=${maxAge}, s-maxage=${maxAge * 7}, stale-while-revalidate=86400`) {
  const tag = `"og-${createHash("sha256").update(publicationCacheKey()).update(ogEtag(card)).digest("hex").slice(0, 24)}"`;
  reply.header("ETag", tag).header("Cache-Control", cacheControl);
  if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
  return reply.type("image/png").send((await renderOg(card)).png);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Not found");
}

const REPORT_NAMES: Record<ReportKind, string> = { daily: withSubject("日报"), weekly: withSubject("周报"), monthly: withSubject("月报") };

export function registerOg(app: FastifyInstance) {
  app.get("/og/site.png", (req, reply) => send(req, reply, (publicationSpace() ? { ...pages().site!, title: publicationSpace()!.name } : pages().site!), 86400));

  app.get("/og/pages/:file", async (req, reply) => {
    const name = (req.params as { file: string }).file.replace(/\.png$/, "");
    const card = Object.hasOwn(pages(), name) ? pages()[name] : undefined;
    if (!card || !(req.params as { file: string }).file.endsWith(".png")) return notFound(reply);
    return send(req, reply, card, 86400);
  });

  app.get("/og/items/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const card = await loadItemOgCard(file.slice(0, -4));
    if (!card) return notFound(reply);
    return send(req, reply, card, 3600, CONTENT_IMAGE_CACHE);
  });

  // Phone share poster for an article (1080×1440), generated on first request and cached by content.
  app.get("/og/posters/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const d = await loadItemShare(file.slice(0, -4));
    if (!d) return notFound(reply);
    const poster: Poster = {
      url: `${config.siteUrl}${publicationPath(`/items/${d.id}`)}`,
      kicker: (d.category ? publicationCategoryLabel(d.category) : null) ?? (publicationSpaceId() === "default" ? withSubject("动态") : "动态"),
      title: d.title,
      summary: d.summary,
      source: d.source.name,
      date: beijingDate(d.timelineAt),
      score: d.selected && ITEM_COPY.showScore ? d.score : null,
    };
    const tag = `"poster-${posterEtag(poster)}"`;
    reply.header("ETag", tag).header("Cache-Control", CONTENT_IMAGE_CACHE);
    if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
    return reply.type("image/png").send((await renderPoster(poster)).png);
  });

  app.get("/og/reports/:kind/:file", async (req, reply) => {
    const { kind, file } = req.params as { kind: string; file: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !file.endsWith(".png")) return notFound(reply);
    const r = await loadReport(kind as ReportKind, file.slice(0, -4));
    if (!r) return notFound(reply);
    const count = r.sections.reduce((n, s) => n + s.items.length, 0);
    return send(req, reply, {
      kicker: `${publicationSpaceId() === "default" ? REPORT_NAMES[r.kind] : { daily: "日报", weekly: "周报", monthly: "月报" }[r.kind]} · ${reportDateLabel(r.kind, r.key)}`,
      title: r.lead?.title ?? r.title,
      subtitle: r.lead?.leadParagraph ?? r.overview,
      // A quiet day's issue (REPORTS.quiet) has nothing to count.
      meta: count > 0 ? `${count} ${REPORTS.shareUnit} · 约 ${r.readingMinutes} 分钟读完` : null,
    }, 3600, CONTENT_IMAGE_CACHE);
  });

  app.get("/og/topics/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const t = file.endsWith(".png") ? findTopic(file.slice(0, -4)) : null;
    if (!t) return notFound(reply);
    return send(req, reply, { kicker: `主题 · ${publicationTopicGroups().find((g) => g.key === t.group)?.name ?? ""}`, title: `${t.name} 最新动态`, subtitle: t.definition }, 86400);
  });

  app.get("/og/stories/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const found = await resolveStory(file.slice(0, -4));
    if (found.kind !== "found") return notFound(reply);
    const s = await loadStoryDetail(found.storyId);
    if (!s) return notFound(reply);
    return send(req, reply, {
      kicker: s.whyHot.rank ? `热点第 ${s.whyHot.rank} · 事件` : "事件",
      title: s.title,
      subtitle: s.latest ?? s.digest,
      meta: `${s.sourceCount} 个来源 · ${s.reportCount} 篇报道`,
      accent: s.whyHot.rank ? "hot" : "teal",
    }, 3600, CONTENT_IMAGE_CACHE);
  });
}
