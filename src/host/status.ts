import { Router, type IRouter } from "express";
import type { BotHostController } from "./controller";

export function createHostRouter(controller: BotHostController): IRouter {
  const router = Router();
  router.get("/", (_request, response) => {
    response.json(controller.getStatus());
  });
  router.get("/status", (_request, response) => {
    response.json(controller.getStatus());
  });
  router.get("/logs", (_request, response) => {
    response.json({ logs: controller.getLogs() });
  });
  return router;
}
