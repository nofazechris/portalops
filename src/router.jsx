import { useEffect, useState } from "react";

// Minimal History-API router: pages live at /, /docs, /auth and /app.
const NAV_EVENT = "pops:navigate";

export function navigate(href) {
  history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAV_EVENT));
  const hash = href.split("#")[1];
  if (!hash) window.scrollTo(0, 0);
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    window.addEventListener(NAV_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAV_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  return path;
}

// Same-origin links navigate client-side; in-page "#anchor" links stay native.
export function Link({ href, children, ...rest }) {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href.startsWith("/")) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={onClick} {...rest}>{children}</a>;
}
