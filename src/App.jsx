import { usePath } from "./router.jsx";
import { SessionProvider } from "./state.jsx";
import Landing from "./pages/Landing.jsx";
import Docs from "./pages/Docs.jsx";
import Auth from "./pages/Auth.jsx";
import Dashboard from "./pages/Dashboard.jsx";

const routes = {
  "/": Landing,
  "/docs": Docs,
  "/auth": Auth,
  "/app": Dashboard,
};

export default function App() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const Page = path === "/docs" || path.startsWith("/docs/") ? Docs : routes[path] || Landing;
  return (
    <SessionProvider>
      <Page key={path} />
    </SessionProvider>
  );
}
