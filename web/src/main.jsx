import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./themes/bundled-fonts";
import "./themes/base.css";
import "./themes/registry"; // pulls in every theme's CSS
import "./styles/global.css";
import { ThemeProvider } from "./themes/ThemeProvider";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
);
