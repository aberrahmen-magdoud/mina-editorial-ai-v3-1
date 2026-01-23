import historyRouter from "../history-router.js";

export function registerHistoryRoutes(app) {
  app.use(historyRouter);
}
