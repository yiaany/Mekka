import { isSqliteSqlEditorId } from './sqlite-sql-editor-routing'

const ENABLED_AUTH_PATHS = new Set([
  "users",
  "providers",
  "url-configuration",
  "templates",
  "register",
]);
const ENABLED_PUBLIC_PATHS = new Set([
  "/404",
  "/500",
  "/logout",
  "/maintenance",
  "/sign-in",
]);

export function getForkProjectRedirect(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "project" || !segments[1]) return undefined;
  if (segments[1] !== "local") {
    segments[1] = "local";
    return getForkProjectRedirect(`/${segments.join("/")}`) ??
      `/${segments.join("/")}`;
  }
  if (segments.length === 2) return `/project/${segments[1]}/editor`;
  if (segments[2] === "auth") {
    if (segments.length === 4 && ENABLED_AUTH_PATHS.has(segments[3]))
      return undefined;
    if (segments.length === 5 && segments[3] === "templates") return undefined;
    return `/project/${segments[1]}/auth/users`;
  }
  if (segments[2] === "sql" && segments.length === 3) {
    return `/project/${segments[1]}/sql/new`;
  }
  if (
    segments[2] === "sql" &&
    (segments.length !== 4 ||
      (segments[3] !== "new" && !isSqliteSqlEditorId(segments[3])))
  ) {
    return `/project/${segments[1]}/sql/new`;
  }
  if (segments[2] === "editor" && segments.length <= 4) return undefined;
  if (segments[2] === "sql") return undefined;

  return `/project/${segments[1]}/editor`;
}

export function getForkRouteRedirect(pathname: string): string | undefined {
  const normalizedPathname =
    pathname !== "/" ? pathname.replace(/\/$/, "") : pathname;
  const projectRedirect = getForkProjectRedirect(normalizedPathname);

  if (projectRedirect) return projectRedirect;
  if (normalizedPathname === "/api" || normalizedPathname.startsWith("/api/"))
    return undefined;
  if (normalizedPathname.startsWith("/project/")) return undefined;
  if (normalizedPathname.startsWith("/auth/")) return undefined;
  if (ENABLED_PUBLIC_PATHS.has(normalizedPathname)) return undefined;

  return "/project/local/editor";
}
