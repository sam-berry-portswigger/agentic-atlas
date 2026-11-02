import "./ui/mantine.css";
import AtlasProvider from "./ui/AtlasProvider";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";
import "./ui/atlas-ui.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AtlasProvider>
      <App />
    </AtlasProvider>
  </React.StrictMode>,
);
