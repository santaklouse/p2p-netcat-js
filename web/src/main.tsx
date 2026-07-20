import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "../app/page";
import "../app/globals.css";

registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration != null) {
      window.setInterval(() => void registration.update(), 60 * 60 * 1000);
    }
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
