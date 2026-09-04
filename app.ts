import express from "express";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok", service: "grand-family-bot" });
});

export default app;