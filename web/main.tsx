import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { get, setCsrf } from "./api";
import { BookingPage, ManageBooking, NotFound, OwnerLanding } from "./booking";
import { AuthPage, AvailabilityPage, EventTypeEditor, EventTypesPage, IntegrationsPage, MeetingsPage, SettingsPage, type Me } from "./owner";
import { navigate, Toaster, useLocation } from "./util";

function OwnerApp({ path, query }: { path: string; query: URLSearchParams }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    get("/auth/session").then(
      (r) => {
        setCsrf(r.csrfToken);
        setMe(r.user);
      },
      () => setMe(null),
    );
  }, []);
  if (me === undefined) return <div class="page-center"><div class="spinner" aria-label="Loading" /></div>;
  if (path === "/login" || path === "/signup") {
    if (me) {
      navigate("/app/event-types", true);
      return null;
    }
    return <AuthPage mode={path === "/login" ? "login" : "signup"} onAuthed={setMe} />;
  }
  if (!me) {
    navigate("/login", true);
    return null;
  }
  if (path === "/app" || path === "/app/") {
    navigate("/app/event-types", true);
    return null;
  }
  let m: RegExpMatchArray | null;
  if (path === "/app/event-types") return <EventTypesPage me={me} path={path} />;
  if (path === "/app/event-types/new") return <EventTypeEditor me={me} path={path} id={null} />;
  if ((m = path.match(/^\/app\/event-types\/([^/]+)$/))) return <EventTypeEditor me={me} path={path} id={m[1]!} />;
  if (path === "/app/availability") return <AvailabilityPage me={me} path={path} query={query} />;
  if (path === "/app/meetings") return <MeetingsPage me={me} path={path} query={query} />;
  if (path === "/app/integrations") return <IntegrationsPage me={me} path={path} query={query} />;
  if (path === "/app/settings") return <SettingsPage me={me} path={path} onMe={setMe} />;
  return <NotFound />;
}

function App() {
  const { path, query } = useLocation();
  let m: RegExpMatchArray | null;
  let page;
  if (path === "/login" || path === "/signup" || path.startsWith("/app")) page = <OwnerApp path={path} query={query} />;
  else if ((m = path.match(/^\/booking\/([^/]+)\/?$/))) page = <ManageBooking id={m[1]!} query={query} />;
  else if ((m = path.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/))) page = <BookingPage key={path} username={m[1]!} slug={m[2]!} query={query} />;
  else if ((m = path.match(/^\/([a-z0-9-]+)\/?$/))) page = <OwnerLanding username={m[1]!} />;
  else page = <NotFound />;
  return (
    <>
      {page}
      <Toaster />
    </>
  );
}

render(<App />, document.getElementById("app")!);
