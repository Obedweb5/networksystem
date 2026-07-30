import type { SmsProvider, SmsSendParams, SmsSendResult } from "./types";
import { logger } from "../logger";

export interface TexinConfig {
  apiKey: string;
  /** Defaults to the real Texin gateway endpoint; overridable for testing or if Texin changes it. */
  gatewayUrl?: string;
}

const DEFAULT_GATEWAY_URL = "https://sms.texin.co.ke/user/billing_gateway.php";

/**
 * Texin's real gateway (confirmed against the actual account) is a simple
 * GET request, not a POST/JSON API:
 *
 *   https://sms.texin.co.ke/user/billing_gateway.php
 *     ?api_key=...&param_number=<msisdn>&param_text=<url-encoded message>
 *
 * There's no separate "secret" — just the api_key. Kenyan phone numbers are
 * normalized to the 2547XXXXXXXX / 2541XXXXXXXX format most Kenyan gateways
 * expect (no leading 0, no +).
 *
 * NOTE: the exact success/failure response body from this endpoint hasn't
 * been confirmed yet (we only have the request URL so far). parseResponse()
 * below treats a 2xx HTTP status as success by default, but also looks for
 * common failure keywords in the body just in case Texin returns HTTP 200
 * even on failure (common with older PHP gateways). If sends silently fail
 * or silently "succeed" without arriving, share a sample response body and
 * this can be tightened up.
 */
export class TexinSmsProvider implements SmsProvider {
  readonly name = "texin";
  private config: TexinConfig;

  constructor(config: TexinConfig) {
    this.config = config;
  }

  async send(params: SmsSendParams): Promise<SmsSendResult> {
    const { apiKey, gatewayUrl = DEFAULT_GATEWAY_URL } = this.config;
    if (!apiKey) {
      return { success: false, error: "Texin is not configured (missing apiKey)." };
    }

    const number = normalizeKenyanNumber(params.to);
    const url = new URL(gatewayUrl);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("param_number", number);
    url.searchParams.set("param_text", params.message);

    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(url.toString(), { method: "GET" });
      bodyText = await response.text();
    } catch (err) {
      logger.error({ err, to: params.to }, "Texin SMS request failed to reach the gateway");
      return { success: false, error: err instanceof Error ? err.message : "Could not reach the Texin SMS gateway" };
    }

    if (!response.ok) {
      logger.error({ status: response.status, body: bodyText, to: params.to }, "Texin SMS gateway returned an error status");
      return { success: false, error: `Texin gateway error (HTTP ${response.status})` };
    }

    return this.parseResponse(bodyText, params.to);
  }

  private parseResponse(bodyText: string, to: string): SmsSendResult {
    const normalized = bodyText.trim().toLowerCase();

    const failureIndicators = ["error", "invalid", "failed", "insufficient", "unauthorized", "invalid api", "low balance", "denied"];
    const looksLikeFailure = failureIndicators.some((kw) => normalized.includes(kw));

    if (looksLikeFailure) {
      logger.error({ body: bodyText, to }, "Texin SMS gateway response indicates failure");
      return { success: false, error: bodyText.trim() || "Texin reported the message was not sent" };
    }

    // No confirmed "success" keyword yet — HTTP 200 with no failure keyword
    // is treated as sent. Logged either way so real responses can be
    // inspected and this can be tightened once the actual success format is known.
    logger.info({ body: bodyText, to }, "Texin SMS gateway response (treated as success)");
    return { success: true };
  }
}

/** Texin (like most Kenyan SMS gateways) expects 2547XXXXXXXX / 2541XXXXXXXX, not 07... or +254... */
function normalizeKenyanNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") || digits.startsWith("1")) return `254${digits}`;
  return digits;
}
