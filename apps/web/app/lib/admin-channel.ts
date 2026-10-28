export function adminSpaceId(pathname: string): string | null {
  const match = /^\/admin\/channels\/([^/]+)(?:\/|$)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function adminChannelPath(spaceId: string, suffix = "/sources"): string {
  if (!spaceId.trim()) throw new Error("An admin channel is required");
  return `/admin/channels/${encodeURIComponent(spaceId)}${suffix}`;
}

export function adminChannelApi(spaceId: string, suffix: string): string {
  if (!spaceId.trim()) throw new Error("An admin channel is required");
  return `/api/admin/spaces/${encodeURIComponent(spaceId)}${suffix}`;
}
