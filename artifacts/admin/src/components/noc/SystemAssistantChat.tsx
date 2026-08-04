import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, Loader2, Send, Sparkles, User, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { getAssistantStatus, sendAssistantChat, type AssistantChatMessage, type AssistantToolTrace } from "@/lib/assistant-api";

interface DisplayMessage extends AssistantChatMessage {
  id: string;
  toolTrace?: AssistantToolTrace[];
}

const SUGGESTIONS = [
  "What does this system do, end to end?",
  "What's missing or not fully built yet?",
  "How many open incidents do we have right now?",
  "Find customer by phone and show their subscription",
];

function ToolTraceDisclosure({ trace }: { trace: AssistantToolTrace[] }) {
  const [open, setOpen] = useState(false);
  if (trace.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-muted/30 text-xs">
      <button className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3 w-3" />
        {trace.length} tool call{trace.length > 1 ? "s" : ""} used
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/60 px-2 py-2">
          {trace.map((t, i) => (
            <div key={i} className="rounded bg-background p-1.5">
              <div className="flex items-center gap-1.5">
                <span className={`font-mono font-medium ${t.ok ? "text-foreground" : "text-red-600"}`}>{t.name}</span>
                {!t.ok && <Badge variant="outline" className="h-4 px-1 text-[10px] text-red-600 border-red-200">failed</Badge>}
              </div>
              {Object.keys(t.input).length > 0 && <div className="mt-0.5 truncate text-muted-foreground">in: {JSON.stringify(t.input)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SystemAssistantChat() {
  const status = useQuery({ queryKey: ["assistant", "status"], queryFn: getAssistantStatus });
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: "user", content };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    setSending(true);
    try {
      const result = await sendAssistantChat(nextHistory.map((m) => ({ role: m.role, content: m.content })));
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: result.reply, toolTrace: result.toolTrace }]);
    } catch (err) {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <Card className="flex h-[560px] flex-col">
      <CardHeader className="flex flex-row items-center justify-between shrink-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          System Assistant
        </CardTitle>
        {status.data && !status.data.configured && (
          <Badge variant="outline" className="text-xs text-muted-foreground">Not configured — set ANTHROPIC_API_KEY</Badge>
        )}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                Ask me anything about this system — how it works, what's happening right now, what's missing — or ask me to do something (suspend a subscription, disconnect a session, resolve an incident).
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
              <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {m.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
              </div>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                {m.toolTrace && <ToolTraceDisclosure trace={m.toolTrace} />}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-end gap-2 border-t border-border pt-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the system, or ask me to do something…"
            className="min-h-[42px] resize-none text-sm"
            rows={1}
          />
          <Button size="icon" onClick={() => void send(input)} disabled={sending || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
