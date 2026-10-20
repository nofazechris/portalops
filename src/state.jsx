import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";

/** Loads data and optionally refreshes it. Keeps the previous value visible while reloading. */
export function useApi(fn, deps, { refreshMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: enabled });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const data = await fnRef.current();
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);

  const key = JSON.stringify([...deps, enabled]);
  const lastKey = useRef(key);
  const fresh = lastKey.current !== key; // dependencies changed in this render: whatever is in state belongs to the old inputs

  useEffect(() => {
    lastKey.current = key;
    seq.current++; // invalidate any request still in flight for the previous inputs
    if (!enabled) { setState({ data: undefined, error: null, loading: false }); return undefined; }
    setState({ data: undefined, error: null, loading: true });
    load();
    if (!refreshMs) return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, refreshMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs]);

  if (fresh) return { data: undefined, error: null, loading: enabled, reload: load };
  return { ...state, loading: state.loading || (enabled && state.data === undefined && !state.error), reload: load };
}

const SessionContext = createContext(null);

/** Auth state plus the active project. `project` is the user's own project, or the public demo when signed out. */
export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectIdState] = useState(() => { try { return localStorage.getItem("pops_project") || null; } catch { return null; } });
  const [demoId, setDemoId] = useState(null);
  const [bootError, setBootError] = useState(null);

  const setProjectId = useCallback((id) => {
    setProjectIdState(id);
    try { id ? localStorage.setItem("pops_project", id) : localStorage.removeItem("pops_project"); } catch { /* storage unavailable */ }
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api.projects();
    setProjects(list);
    setProjectIdState((cur) => (list.some((p) => p.id === cur) ? cur : list[0]?.id ?? null));
    return list;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [status, me] = await Promise.all([
          api.publicStatus().catch(() => null),
          api.me().catch((e) => { if (e instanceof ApiError && e.status === 401) return null; throw e; }),
        ]);
        if (!alive) return;
        setDemoId(status?.demo?.projectId ?? null);
        if (me) { setUser(me.user); await refreshProjects(); } else setUser(null);
      } catch (e) {
        if (alive) { setBootError(e); setUser(null); }
      }
    })();
    return () => { alive = false; };
  }, [refreshProjects]);

  const value = useMemo(() => {
    const own = projects.find((p) => p.id === projectId) ?? null;
    return {
      user, projects, bootError, demoId,
      loading: user === undefined,
      project: own,
      projectId: own ? own.id : user ? null : demoId,
      readOnly: !own,
      setProjectId, refreshProjects,
      async login(email, password) { const r = await api.login(email, password); setUser(r.user); await refreshProjects(); return r.user; },
      async signup(email, password) { const r = await api.signup(email, password); setUser(r.user); setProjects([]); setProjectIdState(null); return r.user; },
      async logout() { await api.logout().catch(() => {}); setUser(null); setProjects([]); setProjectId(null); },
      async createProject(name, description) { const p = await api.createProject({ name, description: description || undefined }); await refreshProjects(); setProjectId(p.id); return p; },
    };
  }, [user, projects, projectId, demoId, bootError, setProjectId, refreshProjects]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const shortHash = (h, a = 10, b = 6) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h || "");
