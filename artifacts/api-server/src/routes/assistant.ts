import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import { runAssistantTurn, isAssistantConfigured, type ChatMessage } from "../services/system-assistant";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/assistant/status", requireAuth, (_req, res) => {
  res.json({ configured: isAssistantConfigured() });
});

const ChatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(8000),
  })).min(1).max(40),
});

// Rate-limit-worthy in a production deployment (each turn can make several
// LLM + tool round trips); left to the app's existing global rate-limit
// middleware rather than a bespoke one here.
router.post("/assistant/chat", requireAuth, async (req, res) => {
  const parse = ChatBody.safeParse(req.body ?? {});
  if (!parse.success) { res.status(400).json({ error: "Invalid body", details: parse.error.flatten() }); return; }
  const { id: userId, tenantId, roles } = req.user!;

  try {
    const result = await runAssistantTurn(parse.data.messages as ChatMessage[], { userId, tenantId, roles });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "System assistant chat turn failed");
    res.status(502).json({ error: "The assistant couldn't complete that request. Try again." });
  }
});

export default router;
