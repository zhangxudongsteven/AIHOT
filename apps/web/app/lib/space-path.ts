/** The URL owns the public channel; neither cookies nor process state change anonymous reads. */
export function spaceSlug(pathname: string): string | null {
  pathname = pathname.replace(/(?:\/_)?\.data$/, "");
  const match = /^\/channels\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}
export function unscopedPath(pathname: string): string {
  return pathname.replace(/^\/channels\/[^/]+(?=\/|$)/, "") || "/";
}
export function spacePath(path: string, slug: string | null | undefined): string {
  if (!slug || !path.startsWith("/") || path.startsWith("//") || /^\/channels(?:\/|$)/.test(path)) return path;
  if (/^\/api\/(?:site|v1)\/spaces(?:\/|$)/.test(path)) return path;
  const encoded = encodeURIComponent(slug);
  if (/^\/api\/site\/(?:feedback|contact|changelog)(?:[/?]|$)/.test(path)) return path;
  if (path.startsWith("/api/site/")) return path.replace("/api/site/", `/api/site/spaces/${encoded}/`);
  if (path.startsWith("/api/v1/")) return path.replace("/api/v1/", `/api/v1/spaces/${encoded}/`);
  if (path === "/api/mcp") return `/api/mcp/spaces/${encoded}`;
  if (/^\/(?:api|admin|assets|media)(?:\/|$)/.test(path) || /^\/(?:icon|favicon|apple-icon|manifest)/.test(path)) return path;
  return `/channels/${encoded}${path.replace(/^\/(?=[?#]|$)/, "")}`;
}
export function browserSpace(): string | null {
  return typeof window === "undefined" ? null : spaceSlug(window.location?.pathname ?? "/");
}
