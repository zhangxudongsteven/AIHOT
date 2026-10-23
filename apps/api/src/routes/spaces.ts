import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { withPublicationSpace } from "@aihot/backend/publication/context";
import { listPublicSpaces, resolveDefaultPublicSpace, resolvePublicSpace } from "@aihot/backend/publication/spaces";
import { applyPublicHeaders, sendJsonWithEtag, sendProblem } from "../http/respond.ts";
import { registerSite } from "./site.ts";
import { registerV1, registerV1Fallbacks } from "./v1.ts";
import { registerAgent } from "./agent.ts";
import { registerFeeds } from "./feeds.ts";
import { registerOg } from "./og.ts";
import { registerStatic } from "./static.ts";
import { registerMcp } from "./mcp.ts";

declare module "fastify" {
  interface FastifyContextConfig { publicationScoped?: boolean }
}

/** The same public handlers at an explicit channel address. Platform/admin writes are not copied. */
function channelRoute(url: string): string | null {
  if (url === "/api/site/feedback" || url.startsWith("/api/site/feedback/")) return null;
  if (url.startsWith("/api/site/")) return url.replace("/api/site/", "/api/site/spaces/:spaceSlug/");
  if (url === "/api/v1" || url.startsWith("/api/v1/")) return url.replace("/api/v1", "/api/v1/spaces/:spaceSlug");
  if (url === "/api/mcp") return "/api/mcp/spaces/:spaceSlug";
  if (url.startsWith("/feed") || url.startsWith("/og/") || url === "/sitemap.xml" || url.startsWith("/sitemaps/") || url === "/llms.txt" || url === "/openapi-v1.json" || /^\/items\/:id\/markdown$/.test(url)) return `/channels/:spaceSlug${url}`;
  return null;
}

type PublicSpace = NonNullable<Awaited<ReturnType<typeof resolvePublicSpace>>>;

function scopedOptions(options: RouteOptions, resolve: (req: FastifyRequest) => Promise<PublicSpace | null>, legacy = false): RouteOptions {
  const scopes = new WeakMap<FastifyRequest, PublicSpace>();
  const enter = async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.url.startsWith("/api/v1") || options.url.endsWith("/openapi-v1.json")) applyPublicHeaders(reply);
    const space = await resolve(req);
    if (!space) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Channel not found." });
    scopes.set(req, space);
  };
  const run = <T>(req: FastifyRequest, fn: () => T) => withPublicationSpace(scopes.get(req)!, fn, { legacy });
  const handler = options.handler;
  const errorHandler = options.errorHandler;
  const previous = options.onRequest ? (Array.isArray(options.onRequest) ? options.onRequest : [options.onRequest]) : [];
  const scopedHooks = previous.map(hook => async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
    return run(req, () => Reflect.apply(hook, this, [req, reply]));
  });
  return {
    ...options, onRequest: [enter, ...scopedHooks], config: { ...options.config, publicationScoped: true },
    handler(req, reply) { return run(req, () => handler.call(this, req, reply)); },
    ...(errorHandler ? { errorHandler(error, req, reply) {
      return scopes.has(req) ? run(req, () => errorHandler.call(this, error, req, reply)) : errorHandler.call(this, error, req, reply);
    } } : {}),
  };
}

/** Legacy addresses always resolve the default registration, regardless of cookies/query parameters. */
export function registerLegacySpaceScope(app: FastifyInstance) {
  app.addHook("onRoute", options => {
    if (options.config?.publicationScoped || options.url.includes(":spaceSlug") || options.url === "/api/site/spaces" || !channelRoute(options.url)) return;
    Object.assign(options, scopedOptions(options as RouteOptions, resolveDefaultPublicSpace, true));
  });
}

export function registerSpaces(app: FastifyInstance) {
  app.get("/api/site/spaces", async (req, reply) => sendJsonWithEtag(req, reply, { spaces: await listPublicSpaces() }, {
    etagPrefix: "spaces", cacheControl: "public, max-age=60, s-maxage=60",
  }));
  const add = (options: RouteOptions) => {
    const url = channelRoute(options.url);
    if (!url) return app;
    return app.route(scopedOptions({ ...options, url }, req => resolvePublicSpace((req.params as { spaceSlug: string }).spaceSlug)));
  };
  // Registration-only adapter: it never changes a request URL or rewrites response bodies.
  const scoped = new Proxy(app, {
    get(target, key) {
      if (key === "route") return add;
      if (["get", "head", "options", "post", "put", "patch", "delete"].includes(String(key))) {
        return (url: string, opts: RouteOptions | RouteOptions["handler"], handler?: RouteOptions["handler"]) => add({
          ...(typeof opts === "function" ? {} : opts), url, method: String(key).toUpperCase() as RouteOptions["method"],
          handler: typeof opts === "function" ? opts : handler!,
        });
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  registerSite(scoped, false);
  registerV1(scoped);
  registerAgent(scoped);
  registerFeeds(scoped);
  registerOg(scoped);
  registerStatic(scoped);
  registerMcp(scoped);
  registerV1Fallbacks(scoped);
}
