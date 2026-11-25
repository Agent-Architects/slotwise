import type { EmailMessage, Mailer } from "../core/ports.js";

/** Default: does not send. The service still records every message in the notifications outbox. */
export class LogMailer implements Mailer {
  readonly id = "log";
  constructor(private quiet = false) {}
  async send(msg: EmailMessage): Promise<void> {
    if (!this.quiet) console.log(`[email:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
  }
}

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly id = "resend";
  constructor(private apiKey: string, private from: string) {}
  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}`);
  }
}
