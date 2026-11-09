import SMTPConnection from "nodemailer/lib/smtp-connection";
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailComposerOptions, SMTPConnectionAuth, SMTPConnectionOptions } from "nodemailer";
import { Readable } from "node:stream";

export interface ActivitySmtpOptions extends SMTPConnectionOptions { auth: SMTPConnectionAuth }
export interface ActivitySmtpClient {
  verify(): Promise<void>;
  sendMail(message: MailComposerOptions, authorize: () => void, writeStarted: () => void): Promise<{ accepted: string[]; rejected: string[] }>;
  close(): void;
}

/** Own the library connection so shutdown can close an active SMTP socket, not just its transport. */
export function activitySmtp(options: ActivitySmtpOptions): ActivitySmtpClient {
  const connection = new SMTPConnection(options);
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  connection.on("error", error => failure.reject(error));
  connection.on("end", () => failure.reject(new Error("SMTP connection closed")));
  let closed = false;
  async function authenticate() {
    if (closed) throw new Error("SMTP connection closed");
    const connected = Promise.withResolvers<void>();
    connection.connect(error => error ? connected.reject(error) : connected.resolve());
    await Promise.race([connected.promise, failure.promise]);
    if (!connection.secureConnection) throw new Error("SMTP TLS is required");
    const authenticated = Promise.withResolvers<void>();
    connection.login(options.auth, error => error ? authenticated.reject(error) : authenticated.resolve());
    await Promise.race([authenticated.promise, failure.promise]);
  }
  return {
    verify: authenticate,
    async sendMail(message, authorize, writeStarted) {
      await authenticate();
      const compiled = new MailComposer(message).compile();
      const content = await compiled.build();
      if (closed) throw new Error("SMTP connection closed");
      authorize();
      const sent = Promise.withResolvers<{ accepted: string[]; rejected: string[] }>();
      // Nodemailer consumes this stream only after the server's 354 DATA response.
      const body = Readable.from((function* () {
        authorize();
        writeStarted();
        yield content;
      })());
      connection.send(compiled.getEnvelope(), body, (error, info) => {
        if (error) sent.reject(error);
        else if (info) sent.resolve({ accepted: info.accepted, rejected: info.rejected });
        else sent.reject(new Error("SMTP acceptance was not confirmed"));
      });
      return Promise.race([sent.promise, failure.promise]);
    },
    close() { closed = true; connection.close(); failure.reject(new Error("SMTP connection closed")); },
  };
}
