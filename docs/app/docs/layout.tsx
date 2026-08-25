import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    // "Users" and "Developers" are root folders, so the layout tabs derive from
    // the tree automatically. Do not pass `tabMode`: it is deprecated in v16 and
    // renders the tab bar into [grid-area:main] with an opaque background, which
    // paints over the whole page body.
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
