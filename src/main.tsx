import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./app/globals.css";
import { Providers } from "./app/providers";
import { AppShell } from "./components/app/app-shell";

if (window.endurance) document.documentElement.dataset.desktop = "true";
createRoot(document.getElementById("root")!).render(<Providers><AppShell /></Providers>);
