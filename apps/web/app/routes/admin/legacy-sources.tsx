import { redirect } from "react-router";

export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/(?:\/_)?\.data$/, "");
  throw redirect(pathname.replace(/^\/admin\/sources(?=\/|$)/, "/admin/channels/default/sources") + url.search);
}

export default function LegacySources() { return null; }
