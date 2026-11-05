import type { JSX, ReactNode } from "react";
import { AuthHeader, AuthLayout } from "@/features/auth/auth-layout";
import { useDocumentTitle } from "@/hooks/use-document-title";

/**
 * A full-page status screen (404, a route that failed), in the sign-in page's frame: the
 * language and theme bar, the app icon over a status code, one h1 and a line of help, then the
 * page's own block (a notice, the actions), and the footer. No showcase panel: the column fills
 * the page.
 */
export function StatusPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
}): JSX.Element {
  useDocumentTitle(title);
  return (
    <AuthLayout showcase={false}>
      <AuthHeader description={description} eyebrow={eyebrow} title={title} />
      <div className="flex flex-col gap-3">{children}</div>
    </AuthLayout>
  );
}
