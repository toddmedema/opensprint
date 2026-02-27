import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { store } from "./store";
import { setQueryClient } from "./queryClient";
import { ThemeProvider } from "./contexts/ThemeContext";
import { DisplayPreferencesProvider } from "./contexts/DisplayPreferencesContext";
import { App } from "./App";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 min — avoid refetch storms
      refetchOnWindowFocus: false, // prevent refetch when switching tabs (was causing UI flash)
    },
  },
});
setQueryClient(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>
  </StrictMode>
);
