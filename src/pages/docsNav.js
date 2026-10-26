// The public documentation: which markdown files from /docs appear on the site, in what order. Pure data, so tests can check it
// against the files on disk (a doc that is not listed here is invisible on the site, and a listed doc that does not exist is a dead link).
export const DOC_SECTIONS = [
  {
    title: "Get started",
    items: [
      { path: "guides/product-overview", title: "What is PortalOps?" },
      { path: "guides/quickstart", title: "Quickstart" },
      { path: "guides/concepts", title: "Core concepts" },
      { path: "guides/dashboard-tour", title: "Dashboard tour" },
      { path: "guides/use-cases", title: "Use cases and recipes" },
    ],
  },
  {
    title: "Tutorials",
    items: [
      { path: "tutorials/index", title: "Tutorials overview" },
      { path: "tutorials/first-webhook", title: "1. Your first webhook" },
      { path: "tutorials/game-feed", title: "2. Build a game feed" },
      { path: "tutorials/import-your-contract", title: "3. Import your own contract" },
      { path: "tutorials/with-claude", title: "4. Set it all up with Claude" },
      { path: "tutorials/with-the-sdk", title: "5. Automate with the SDK" },
    ],
  },
  {
    title: "Guides",
    items: [
      { path: "guides/accounts", title: "Accounts and sign-in" },
      { path: "guides/contracts-and-examples", title: "Contracts and examples" },
      { path: "guides/game-development", title: "Game development" },
      { path: "guides/webhooks", title: "Receiving webhooks" },
      { path: "guides/claude-setup", title: "Set up with Claude" },
      { path: "guides/sdk", title: "TypeScript SDK" },
      { path: "guides/troubleshooting", title: "Troubleshooting" },
      { path: "guides/faq", title: "FAQ" },
    ],
  },
  {
    title: "Reference",
    items: [
      { path: "reference/api", title: "REST API" },
      { path: "reference/environment", title: "Configuration" },
    ],
  },
  {
    title: "Architecture",
    items: [
      { path: "architecture/overview", title: "Architecture" },
      { path: "architecture/network-compatibility", title: "Portaldot network notes" },
    ],
  },
  {
    title: "Operations",
    items: [
      { path: "operations/live-deploy", title: "Put it live (Neon + Render)" },
      { path: "operations/deployment", title: "Deployment and backups" },
    ],
  },
  {
    title: "Security",
    items: [{ path: "security/review", title: "Security review" }],
  },
];

export const DEFAULT_DOC = "guides/product-overview";
export const DOC_LIST = DOC_SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title })));
export const findDoc = (path) => DOC_LIST.find((d) => d.path === path) ?? null;

/** Markdown files in /docs that are deliberately NOT on the public site (internal runbooks, scripts, the index for GitHub readers). */
export const INTERNAL_DOCS = ["README", "operations/demo-script", "operations/video-script", "operations/walkthrough-script", "operations/crash-investigation"];
