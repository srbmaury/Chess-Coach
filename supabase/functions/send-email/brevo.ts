import type { AuthEmailMessage } from "./auth-email.ts";

export interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

export class BrevoDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrevoDeliveryError";
  }
}

export async function sendBrevoEmail(
  message: AuthEmailMessage,
  config: BrevoConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;

  try {
    response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": config.apiKey,
      },
      body: JSON.stringify({
        sender: {
          email: config.senderEmail,
          name: config.senderName,
        },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.htmlContent,
        textContent: message.textContent,
      }),
    });
  } catch {
    throw new BrevoDeliveryError("Brevo request failed");
  }

  if (!response.ok) {
    throw new BrevoDeliveryError(`Brevo rejected the message (${response.status})`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new BrevoDeliveryError("Brevo returned an invalid response");
  }

  const messageId =
    result && typeof result === "object" && "messageId" in result
      ? (result as { messageId?: unknown }).messageId
      : undefined;

  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new BrevoDeliveryError("Brevo did not return a message id");
  }

  return messageId;
}
