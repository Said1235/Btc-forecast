import { AppProvider } from "./state/AppContext";
import { Landing } from "./pages/Landing";
import { AppPage } from "./pages/AppPage";
import { DemoBar, Toasts, TopBar } from "./ui/Shell";
import { useHashRoute } from "./ui/parts";


function Routes() {
  const page = useHashRoute();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <TopBar page={page} />
      <DemoBar />
      <div key={page} className="page-in">{page === "landing" ? <Landing /> : <AppPage />}</div>
      <nav className="tabs" aria-label="Sections">
        <a href="#/" aria-current={page === "landing" ? "page" : undefined}>About</a>
        <a href="#/app" aria-current={page === "app" ? "page" : undefined}>Forecast</a>
      </nav>
      <Toasts />
    </>
  );
}

export function App() {
  return <AppProvider><Routes /></AppProvider>;
}
