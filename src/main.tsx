import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// KaTeX's stylesheet, which the math plugin names (getStyles) but does not load. Without it each formula shows twice
// (the drawn one and its MathML copy for screen readers) and drawn parts such as square roots stretch across the page.
// Loaded here with the other app-wide styles, so it is in place before any reply renders.
import "katex/dist/katex.min.css";
import "./app/globals.css";
import { Providers } from "./app/providers";
import { AppShell } from "./components/app/app-shell";

if (window.endurance) document.documentElement.dataset.desktop = "true";
createRoot(document.getElementById("root")!).render(<Providers><AppShell /></Providers>);
