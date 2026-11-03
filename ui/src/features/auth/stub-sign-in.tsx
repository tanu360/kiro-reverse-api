import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type JSX, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api/server-errors";
import { signIn } from "@/lib/auth/session";
import { useT } from "@/lib/i18n";
import { redirectTarget } from "@/routes/-search";

/**
 * Stub sign-in form shared by the stub Login and Setup pages, so every wave can sign in
 * (mock first-run is pending on each fresh load, which lands on /setup). Task 12 replaces it.
 */
export function StubSignIn({ title, redirect }: { title: string; redirect?: string }): JSX.Element {
  const { t } = useT("auth");
  const navigate = useNavigate();
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(password, remember);
      setPassword("");
      const { to, search } = redirectTarget(redirect);
      await navigate({ to, search: () => search });
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center p-4" id="main">
      <Card className="w-full max-w-sm gap-4 p-6">
        <h1 className="font-heading font-medium text-xl">{title}</h1>
        <form autoComplete="on" className="flex flex-col gap-4" onSubmit={onSubmit}>
          <input autoComplete="username" hidden name="username" readOnly value="admin" />
          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordId}>{t("password")}</Label>
            <Input
              aria-describedby={error ? `${passwordId}-error` : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="current-password"
              autoFocus
              id={passwordId}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
            {error ? (
              <p
                className="text-destructive-foreground text-sm"
                id={`${passwordId}-error`}
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
          <Label>
            <Checkbox
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            {t("remember")}
          </Label>
          <Button className="h-10" loading={pending} type="submit">
            {pending ? t("signingIn") : t("submit")}
          </Button>
        </form>
      </Card>
    </main>
  );
}
