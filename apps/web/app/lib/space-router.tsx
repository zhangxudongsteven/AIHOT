import { forwardRef, useCallback } from "react";
import { Link as RouterLink, Form as RouterForm, useLocation, useNavigate as routerNavigate, type LinkProps, type FormProps, type NavigateFunction, type NavigateOptions, type To } from "react-router";
import { spacePath, spaceSlug } from "./space-path";
export * from "react-router";
function scopedTo(to: To, slug: string | null): To {
  return typeof to === "string" ? spacePath(to, slug) : { ...to, ...(to.pathname ? { pathname: spacePath(to.pathname, slug) } : {}) };
}
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...props }, ref) {
  const slug = spaceSlug(useLocation().pathname);
  return <RouterLink {...props} ref={ref} to={scopedTo(to, slug)} />;
});
export const Form = forwardRef<HTMLFormElement, FormProps>(function Form({ action, ...props }, ref) {
  const slug = spaceSlug(useLocation().pathname);
  return <RouterForm {...props} ref={ref} action={action ? spacePath(action, slug) : action} />;
});
export function useNavigate(): NavigateFunction {
  const navigate = routerNavigate();
  const slug = spaceSlug(useLocation().pathname);
  return useCallback(((to: To | number, options?: NavigateOptions) => typeof to === "number" ? navigate(to) : navigate(scopedTo(to, slug), options)) as NavigateFunction, [navigate, slug]);
}
